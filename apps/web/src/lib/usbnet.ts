// WebUSB side of the live log: claim the phone's CDC-ECM networking interface (the same one that carries
// SSH and the kernel log once iOS is up), bring it up, and stream Ethernet frames in and out.
//
// This is the one piece that needs a real device to confirm: it assumes iOS exposes a standard CDC-ECM
// function (Communications interface class 0x02 / subclass 0x06 ECM, plus a Data interface class 0x0A with
// a bulk IN/OUT pair on an alternate setting). The netlog/ethernet layers that consume these frames are
// unit-tested; this file is kept deliberately small and is marked experimental in the UI.

const CDC_COMM = 0x02; // Communications Interface Class
const CDC_ECM_SUBCLASS = 0x06; // Ethernet Networking Control Model
const CDC_DATA = 0x0a; // Data Interface Class
// Bergamota's own link (kernel 0256, boot-arg sweetusbraw=1): the same Ethernet frames on one vendor interface
// (class 0xff, subclass 0x42 'B', protocol 1), 1209:0002. No OS has a driver for it, so an Android tablet or a Linux
// cdc_ether never takes it: the page claims it with no setup on the computer.
const VENDOR = 0xff;
const BERGA_SUBCLASS = 0x42;
const BERGA_PROTOCOL = 0x01;
const SET_ETHERNET_PACKET_FILTER = 0x43;
// filter bits: PROMISCUOUS | ALL_MULTICAST | DIRECTED | BROADCAST — accept everything the phone sends us
const PACKET_FILTER_ALL = 0x0f;

/** Filters for the device picker: the CDC Communications or Data interface class, or Bergamota's own vendor link. */
export const USBNET_FILTERS: USBDeviceFilter[] = [
  { classCode: CDC_COMM },
  { classCode: CDC_DATA },
  { vendorId: 0x1209, productId: 0x0002 },
  { classCode: VENDOR, subclassCode: BERGA_SUBCLASS, protocolCode: BERGA_PROTOCOL },
];

/** kind: "access" = the OS denies the browser the device (Linux: no udev rule for 1209:0001);
 * "busy" = the OS's own driver (Linux cdc_ether) holds the interface. raw = the browser's own error. */
export class UsbNetError extends Error {
  kind: "access" | "busy" | "other";
  raw: string;
  constructor(message: string, kind: "access" | "busy" | "other" = "other", raw = "") {
    super(message);
    this.kind = kind;
    this.raw = raw;
  }
}

const rawOf = (e: unknown) => `${(e as Error)?.name ?? "Error"}: ${(e as Error)?.message ?? String(e)}`;

function isRaw(a: USBAlternateInterface): boolean {
  return a.interfaceClass === VENDOR && a.interfaceSubclass === BERGA_SUBCLASS && a.interfaceProtocol === BERGA_PROTOCOL;
}

function isData(a: USBAlternateInterface): boolean {
  return (a.interfaceClass === CDC_DATA || isRaw(a)) && a.endpoints.some((e) => e.type === "bulk");
}

export class UsbNet {
  readonly usb: USBDevice;
  private epIn = 0;
  private epOut = 0;
  private mtu = 1600;
  private dataIface = -1;
  private commIface = -1;
  private epNotify = 0;
  /** True on Bergamota's own vendor link (sweetusbraw=1): no CDC, nothing for the computer's OS to take. */
  raw = false;
  /** Latest ECM NETWORK_CONNECTION notification: true = the phone says the link is up. */
  linkUp: boolean | null = null;
  notifications = 0;
  private stopped = false;

  private constructor(usb: USBDevice) {
    this.usb = usb;
  }

  static supported(): boolean {
    return typeof navigator !== "undefined" && "usb" in navigator;
  }

  static async request(): Promise<UsbNet> {
    const dev = await navigator.usb.requestDevice({ filters: USBNET_FILTERS });
    return UsbNet.open(dev);
  }

  static async known(): Promise<USBDevice[]> {
    return (await navigator.usb.getDevices()).filter((d) => d.configurations.some((c) => c.interfaces.some((i) => i.alternates.some(isData))));
  }

  static async open(dev: USBDevice): Promise<UsbNet> {
    const net = new UsbNet(dev);
    try {
      if (!dev.opened) await dev.open();
    } catch (e) {
      throw new UsbNetError("the computer does not let the browser open the phone's USB device", "access", rawOf(e));
    }
    if (!dev.configuration) await dev.selectConfiguration(dev.configurations[0].configurationValue);
    const cfg = dev.configuration!;

    const data = cfg.interfaces.find((i) => i.alternates.some(isData));
    if (!data) throw new UsbNetError("this device has no network interface (CDC-ECM or Bergamota link): is the phone booted into iOS with USB networking?");
    const alt = data.alternates.find(isData)!;
    net.dataIface = data.interfaceNumber;
    net.raw = isRaw(alt);

    const comm = cfg.interfaces.find((i) => i.alternates.some((a) => a.interfaceClass === CDC_COMM && a.interfaceSubclass === CDC_ECM_SUBCLASS));
    net.commIface = comm?.interfaceNumber ?? -1;
    const commAlt = comm?.alternates.find((a) => a.interfaceClass === CDC_COMM);
    net.epNotify = commAlt?.endpoints.find((e) => e.type === "interrupt" && e.direction === "in")?.endpointNumber ?? 0;

    // Claim the control interface first so we can enable reception, then the data interface.
    try {
      if (comm) await dev.claimInterface(comm.interfaceNumber);
      await dev.claimInterface(data.interfaceNumber);
    } catch (e) {
      throw new UsbNetError(
        net.raw ? "the browser could not claim the Bergamota link (another tab or app has it open?)" : "another driver holds the phone's network interface (Linux: cdc_ether; on Android or without root, boot an image with sweetusbraw=1)",
        "busy",
        rawOf(e),
      );
    }
    // ECM carries the data endpoints on a non-zero alternate setting; select it to turn them on.
    if (alt.alternateSetting !== 0) await dev.selectAlternateInterface(data.interfaceNumber, alt.alternateSetting);

    for (const ep of alt.endpoints) {
      if (ep.type !== "bulk") continue;
      if (ep.direction === "in") {
        net.epIn = ep.endpointNumber;
        net.mtu = Math.max(1600, ep.packetSize * 2);
      } else net.epOut = ep.endpointNumber;
    }
    if (!net.epIn || !net.epOut) throw new UsbNetError("the data interface has no bulk IN/OUT pair");

    // Ask the device to deliver directed, broadcast and multicast frames (ECM needs this to receive).
    if (net.commIface >= 0) {
      try {
        await dev.controlTransferOut({ requestType: "class", recipient: "interface", request: SET_ETHERNET_PACKET_FILTER, value: PACKET_FILTER_ALL, index: net.commIface });
      } catch {
        /* some stacks accept frames without it; keep going */
      }
    }
    return net;
  }

  /** Send one Ethernet frame to the phone (e.g. an ARP reply). */
  async send(frame: Uint8Array): Promise<void> {
    if (this.stopped) return;
    // copy into a plain ArrayBuffer-backed view (WebUSB wants ArrayBuffer, not ArrayBufferLike)
    const out = new Uint8Array(frame.length);
    out.set(frame);
    const r = await this.usb.transferOut(this.epOut, out);
    if (r.status !== "ok") throw new UsbNetError(`USB write failed (${r.status})`);
  }

  /** Reads the ECM interrupt endpoint (NETWORK_CONNECTION / SPEED_CHANGE), as cdc_ether does. Runs until close(). */
  async pollNotifications(): Promise<void> {
    if (!this.epNotify) return;
    while (!this.stopped) {
      try {
        const r = await this.usb.transferIn(this.epNotify, 16);
        if (r.status === "ok" && r.data && r.data.byteLength >= 8) {
          this.notifications++;
          // bmRequestType 0xa1, bNotificationCode 0x00 = NETWORK_CONNECTION, wValue 1 = connected
          if (r.data.getUint8(1) === 0x00) this.linkUp = r.data.getUint16(2, true) === 1;
        } else if (r.status === "stall") await this.usb.clearHalt("in", this.epNotify).catch(() => {});
      } catch {
        return;
      }
    }
  }

  /** Each received Ethernet frame, until close() or the device goes away. */
  async *frames(): AsyncGenerator<Uint8Array> {
    while (!this.stopped) {
      let res: USBInTransferResult;
      try {
        res = await this.usb.transferIn(this.epIn, this.mtu);
      } catch (e) {
        if (this.stopped) return;
        throw new UsbNetError(`USB read failed: ${(e as Error).message}`);
      }
      if (this.stopped) return;
      if (res.status === "stall") {
        await this.usb.clearHalt("in", this.epIn).catch(() => {});
        continue;
      }
      if (res.status !== "ok" || !res.data || res.data.byteLength < 14) continue;
      yield new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength);
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    for (const n of [this.dataIface, this.commIface]) {
      if (n < 0) continue;
      await this.usb.releaseInterface(n).catch(() => {});
    }
    await this.usb.close().catch(() => {});
  }
}
