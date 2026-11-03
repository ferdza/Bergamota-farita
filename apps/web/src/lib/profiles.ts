// Renegade's target profiles (tools/renegade/targets.py): which IPSW each root is built from.
export interface Profile {
  id: "ios26" | "ios18";
  device: string;
  model: string;
  version: string;
  build: string;
  // The exact Apple restore IPSW this profile is built from. These are Apple's own
  // servers (updates.cdn-apple.com); nothing is hosted here. There are many builds per
  // device, so we pin the one Renegade actually has a profile for.
  url: string;
  size: number; // bytes, for showing the download size up front
}

export const PROFILES: Profile[] = [
  {
    id: "ios18",
    device: "iPhone11,8",
    model: "iPhone XR",
    version: "18.7.8",
    build: "22H352",
    url: "https://updates.cdn-apple.com/2026WinterFCS/fullrestores/122-58419/209B7F8A-225C-49D6-BFA4-C95F360DDD69/iPhone11,8_18.7.8_22H352_Restore.ipsw",
    size: 8683785175,
  },
  {
    id: "ios26",
    device: "iPhone12,1",
    model: "iPhone 11",
    version: "26.6.2",
    build: "23G90",
    url: "https://updates.cdn-apple.com/2026SummerFCS/4054a88c-e206-4849-817b-8a6263d42ddb/iPhone12,1_26.6.2_23G90_Restore.ipsw",
    size: 9817538824,
  },
];

/** Apple names restore IPSWs <device>_<version>_<build>_Restore.ipsw. */
export function profileForIpsw(name: string): { profile: Profile | null; device?: string; version?: string; build?: string } {
  const m = /^(iPhone\d+,\d+)_([\d.]+)_([0-9A-Za-z]+)_Restore\.ipsw$/.exec(name);
  if (!m) return { profile: null };
  const [, device, version, build] = m;
  return { profile: PROFILES.find((p) => p.device === device && p.build === build) ?? null, device, version, build };
}
