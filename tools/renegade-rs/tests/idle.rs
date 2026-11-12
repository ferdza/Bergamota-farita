//! idle(): the respawn/crash loops are quieted in the root, reversibly, idempotently, without touching the
//! GPU / SSH / USB-net path. DirFs (a folder, like the Python) and TreeFs (the root build's in-memory tree).
use renegade::plist::{self, Value};
use renegade::tweaks::{idle, DirFs, Fs, TreeFs, DISABLED_PLIST, IDLE_DISABLE, IDLE_PARK, IDLE_THROTTLE, LAUNCHD_PLIST, PARK_DIR, QUIET_THROTTLE};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

fn job(label: &str, extra: Vec<(&str, Value)>) -> Value {
    let mut d = BTreeMap::new();
    d.insert("Label".to_string(), Value::String(label.into()));
    d.insert("ProgramArguments".to_string(), Value::Array(vec![Value::String(format!("/usr/libexec/{label}"))]));
    for (k, v) in extra {
        d.insert(k.to_string(), v);
    }
    Value::Dict(d)
}

fn put(root: &Path, rel: &str, data: &[u8]) {
    let p = root.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, data).unwrap();
}

/// A small root: launchd.plist with the loops, the protected jobs and a throttled-already one; the parkable binaries.
fn make(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("renegade-idle-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    let mut jobs = BTreeMap::new();
    for (l, extra) in [
        ("com.apple.backboardd", vec![]),
        ("org.sweet.dropbear", vec![]),
        ("com.apple.usbmuxd", vec![]),
        ("com.apple.usernotificationsd", vec![]),
        ("com.apple.watchdogd", vec![("ThrottleInterval", Value::Integer(300))]),
        ("com.apple.replicatord", vec![("ThrottleInterval", Value::Integer(3))]),
        ("com.apple.gamepolicyd", vec![]),
    ] {
        jobs.insert(format!("/System/Library/LaunchDaemons/{l}.plist"), job(l, extra));
    }
    let mut root = BTreeMap::new();
    root.insert("LaunchDaemons".to_string(), Value::Dict(jobs));
    put(&d, LAUNCHD_PLIST, &plist::to_binary(&Value::Dict(root)));
    for n in IDLE_PARK {
        put(&d, &format!("System/Library/Frameworks/Speech.framework/PlugIns/{n}.appex/{n}"), n.as_bytes());
    }
    put(&d, "System/Library/PrivateFrameworks/Other.framework/PlugIns/Keep.appex/Keep", b"keep");
    put(&d, "usr/libexec/backboardd", b"bb");
    d
}

fn snapshot(d: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut out = BTreeMap::new();
    let mut todo = vec![d.to_path_buf()];
    while let Some(dir) = todo.pop() {
        for e in std::fs::read_dir(&dir).unwrap() {
            let p = e.unwrap().path();
            let m = std::fs::symlink_metadata(&p).unwrap();
            let rel = p.strip_prefix(d).unwrap().display().to_string();
            if m.is_dir() {
                todo.push(p);
            } else if m.file_type().is_symlink() {
                out.insert(rel, std::fs::read_link(&p).unwrap().display().to_string().into_bytes());
            } else {
                out.insert(rel, std::fs::read(&p).unwrap());
            }
        }
    }
    out
}

fn disabled(d: &Path) -> BTreeMap<String, Value> {
    plist::parse(&std::fs::read(d.join(DISABLED_PLIST)).unwrap()).unwrap().as_dict().unwrap().clone()
}

fn throttle_of(d: &Path, label: &str) -> Option<i128> {
    let pl = plist::parse(&std::fs::read(d.join(LAUNCHD_PLIST)).unwrap()).unwrap();
    pl.get("LaunchDaemons").unwrap().as_dict().unwrap().values().find(|j| j.get("Label").and_then(Value::as_str) == Some(label)).and_then(|j| match j.get("ThrottleInterval") {
        Some(Value::Integer(i)) => Some(*i),
        _ => None,
    })
}

#[test]
fn disables_the_loops_and_nothing_on_the_gpu_ssh_usb_path() {
    let d = make("disable");
    // an existing disabled.plist keeps its other keys
    let mut pre = BTreeMap::new();
    pre.insert("com.apple.something.else".to_string(), Value::Bool(true));
    pre.insert("com.apple.asd".to_string(), Value::Bool(false));
    put(&d, DISABLED_PLIST, &plist::to_binary(&Value::Dict(pre)));
    let mut fs = DirFs::new(&d);
    let mut log = vec![];
    idle(&mut fs, &mut log, false).unwrap();
    let dis = disabled(&d);
    for l in IDLE_DISABLE.iter().chain(["com.apple.bluetoothd"].iter()) {
        assert!(matches!(dis.get(*l), Some(Value::Bool(true))), "{l} not disabled: {dis:?}");
    }
    assert!(matches!(dis.get("com.apple.something.else"), Some(Value::Bool(true))), "other keys kept");
    assert_eq!(dis.len(), IDLE_DISABLE.len() + 2);
    // the jobs the display, SSH and USB networking need are neither disabled nor removed
    for l in ["com.apple.backboardd", "org.sweet.dropbear", "com.apple.usbmuxd", "SpringBoard", "com.apple.configd", "com.apple.lockdownd"] {
        assert!(!dis.contains_key(l), "{l} must stay enabled");
    }
    let pl = std::fs::read(d.join(LAUNCHD_PLIST)).unwrap();
    for l in ["backboardd", "dropbear", "usbmuxd"] {
        assert!(String::from_utf8_lossy(&pl).contains(l) || plist::parse(&pl).unwrap().get("LaunchDaemons").unwrap().as_dict().unwrap().keys().any(|k| k.contains(l)), "{l} job kept in launchd.plist");
    }
    assert!(std::fs::read(d.join("usr/libexec/backboardd")).unwrap() == b"bb");
    assert!(log[0].starts_with("idle: disabled.plist +"), "{log:?}");
    assert!(d.join("private/var/root/IDLE-CPU.txt").is_file(), "the undo note is on the root");
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn bluetoothd_stays_when_the_bluetooth_stub_is_there() {
    let d = make("bt");
    let mut fs = DirFs::new(&d);
    idle(&mut fs, &mut vec![], true).unwrap();
    assert!(!disabled(&d).contains_key("com.apple.bluetoothd"));
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn throttles_up_never_down_and_only_existing_jobs() {
    let d = make("throttle");
    let mut fs = DirFs::new(&d);
    idle(&mut fs, &mut vec![], false).unwrap();
    assert_eq!(throttle_of(&d, "com.apple.usernotificationsd"), Some(60));
    assert_eq!(throttle_of(&d, "com.apple.replicatord"), Some(60), "3 -> 60");
    assert_eq!(throttle_of(&d, "com.apple.watchdogd"), Some(300), "a higher value is kept");
    assert_eq!(throttle_of(&d, "com.apple.backboardd"), None);
    assert!(IDLE_THROTTLE.iter().all(|(_, t)| *t >= 10) && QUIET_THROTTLE.iter().all(|(_, t)| *t >= 10));
    let pl = plist::parse(&std::fs::read(d.join(LAUNCHD_PLIST)).unwrap()).unwrap();
    assert_eq!(pl.get("LaunchDaemons").unwrap().as_dict().unwrap().len(), 7, "no job removed from launchd.plist");
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn parks_the_crashing_extensions_with_a_restorable_readme() {
    let d = make("park");
    std::os::unix::fs::symlink("SiriAUSP", d.join("usr/libexec/MauiAUSP")).unwrap(); // a symlink with a parked name is left alone
    let mut fs = DirFs::new(&d);
    let mut log = vec![];
    idle(&mut fs, &mut log, false).unwrap();
    let readme = std::fs::read_to_string(d.join(PARK_DIR).join("README")).unwrap();
    assert_eq!(readme.lines().count(), IDLE_PARK.len(), "{readme}");
    for n in IDLE_PARK {
        let orig = format!("/System/Library/Frameworks/Speech.framework/PlugIns/{n}.appex/{n}");
        assert!(!d.join(orig.trim_start_matches('/')).exists(), "{n} still in place");
        let dest = format!("/var/root/disabled-bin/{}", orig.replace('/', "_"));
        assert!(readme.lines().any(|l| l == format!("{dest} {orig}")), "{readme}");
        assert_eq!(std::fs::read(d.join(dest.trim_start_matches('/').replace("var/root", "private/var/root"))).unwrap(), n.as_bytes());
    }
    assert!(d.join("System/Library/PrivateFrameworks/Other.framework/PlugIns/Keep.appex/Keep").is_file(), "other plug-ins untouched");
    assert!(std::fs::symlink_metadata(d.join("usr/libexec/MauiAUSP")).unwrap().file_type().is_symlink());
    // the web page's restore loop (`while read d p; mv $d $p`) puts every file back
    for l in readme.lines() {
        let (dst, orig) = l.split_once(' ').unwrap();
        let from = d.join(dst.trim_start_matches('/').replacen("var/root", "private/var/root", 1));
        std::fs::rename(from, d.join(orig.trim_start_matches('/'))).unwrap();
    }
    assert_eq!(std::fs::read(d.join("System/Library/Frameworks/Speech.framework/PlugIns/SiriAUSP.appex/SiriAUSP")).unwrap(), b"SiriAUSP");
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn is_idempotent() {
    let d = make("twice");
    let mut fs = DirFs::new(&d);
    idle(&mut fs, &mut vec![], false).unwrap();
    let once = snapshot(&d);
    let mut log = vec![];
    idle(&mut fs, &mut log, false).unwrap();
    assert!(snapshot(&d) == once, "a second run changes nothing");
    assert_eq!(log[0], "idle: disabled.plist +0 [], ThrottleInterval raised on 0, parked 0 []");
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn works_on_a_root_without_launchd_plist_or_plugins() {
    let d = std::env::temp_dir().join(format!("renegade-idle-empty-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    let mut fs = DirFs::new(&d);
    idle(&mut fs, &mut vec![], false).unwrap();
    assert!(d.join(DISABLED_PLIST).is_file());
    assert!(!d.join(PARK_DIR).exists());
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn the_root_build_tree_gets_the_same_result() {
    let d = make("tree");
    let (entries, paths, _) = renegade::tree::scan_dir(&d).unwrap();
    let n = paths.len();
    let mut t = TreeFs::new(entries, n, 0, |i| std::fs::read(&paths[i]));
    let mut log = vec![];
    idle(&mut t, &mut log, false).unwrap();
    let dis = plist::parse(&t.read(DISABLED_PLIST).unwrap()).unwrap();
    assert!(matches!(dis.get("com.apple.gamepolicyd"), Some(Value::Bool(true))));
    let o = IDLE_PARK[0];
    let orig = format!("System/Library/Frameworks/Speech.framework/PlugIns/{o}.appex/{o}");
    assert!(!t.exists(&orig));
    assert!(t.exists(&format!("{PARK_DIR}/_{}", orig.replace('/', "_"))));
    let first = log[0].clone();
    let mut log2 = vec![];
    idle(&mut t, &mut log2, false).unwrap();
    assert_eq!(log2[0], "idle: disabled.plist +0 [], ThrottleInterval raised on 0, parked 0 []");
    assert!(first.contains("parked 5"));
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn on_in_the_root_build_off_in_a_bare_tweaks_config() {
    assert!(renegade::rootbuild::Config::default().idle, "the root build quiets the loops by default");
    assert!(!renegade::tweaks::Config::default().idle);
}
