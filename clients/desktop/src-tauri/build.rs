fn main() {
    // tauri-build embeds icons/icon.ico into the executable, but only asks Cargo to re-run this
    // script when tauri.conf.json or capabilities/ change - never the icons. Replacing the icon
    // files and rebuilding therefore shipped the OLD icon, silently: observed after swapping
    // the scaffold's Tauri logo for the Nexus artwork. Watching the directory (Cargo scans it
    // recursively) makes an icon change re-embed like any other input.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
