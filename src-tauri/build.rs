fn main() {
    println!(
        "cargo:rustc-env=NEODISC_TARGET={}",
        std::env::var("TARGET").unwrap()
    );
    tauri_build::build()
}
