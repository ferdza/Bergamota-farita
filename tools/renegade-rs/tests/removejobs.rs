use renegade::plist::{self, Value};
use renegade::tweaks::{remove_jobs, UNPORTED_JOBS};
use std::collections::BTreeMap;

fn job(label: &str, prog: &str) -> Value {
    let mut d = BTreeMap::new();
    d.insert("Label".to_string(), Value::String(label.into()));
    d.insert("ProgramArguments".to_string(), Value::Array(vec![Value::String(prog.into())]));
    Value::Dict(d)
}

#[test]
fn removes_by_label_or_program() {
    let mut daemons = BTreeMap::new();
    daemons.insert("/System/Library/LaunchDaemons/com.apple.bluetoothd.plist".to_string(), job("com.apple.bluetoothd", "/usr/sbin/bluetoothd"));
    daemons.insert("/System/Library/LaunchDaemons/com.apple.mobile.softwareupdated.plist".to_string(), job("com.apple.mobile.softwareupdated", "/usr/libexec/softwareupdated"));
    daemons.insert("/System/Library/LaunchDaemons/com.apple.backboardd.plist".to_string(), job("com.apple.backboardd", "/usr/libexec/backboardd"));
    let mut root = BTreeMap::new();
    root.insert("LaunchDaemons".to_string(), Value::Dict(daemons));
    let src = plist::to_binary(&Value::Dict(root));
    let (out, removed) = remove_jobs(&src, &UNPORTED_JOBS).unwrap();
    assert_eq!(removed, vec!["com.apple.bluetoothd", "com.apple.mobile.softwareupdated"]);
    let v = plist::parse(&out).unwrap();
    let d = v.get("LaunchDaemons").unwrap().as_dict().unwrap();
    assert_eq!(d.len(), 1);
    assert!(d.keys().any(|k| k.contains("backboardd")));
}
