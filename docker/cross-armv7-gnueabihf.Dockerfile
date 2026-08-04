# Custom `cross` build image for armv7-unknown-linux-gnueabihf, based on
# Debian Bookworm to match Raspberry Pi OS's actual glibc (2.36) exactly.
#
# The default cross-rs image for this target is Ubuntu-based with a newer
# glibc (2.38), which produces binaries that fail to run on the Pi with
# "version `GLIBC_2.38' not found". We tried armv7-unknown-linux-musleabihf
# (static musl) to sidestep that, but hit a worse problem: musl builds link
# Rust's LLVM-based `libunwind`, while DuckDB (compiled by this image's GCC)
# throws real C++ exceptions expecting GCC's own unwinder — mixing the two
# crashes the process ("libunwind: personality function returned unknown
# result") the first time any DuckDB code path actually throws. Building
# against glibc keeps Rust and DuckDB's C++ sharing the same system
# `libgcc_s` unwinder, which avoids that whole class of bug. See
# DEVELOPMENT.md for the full story.
#
# `cross` mounts your host's rustup/cargo installation into the container at
# build time — this image only needs to provide the OS/libc environment and
# the C/C++ cross-toolchain, not Rust itself.
FROM debian:bookworm-slim

# `build-essential` provides a *native* (x86_64) `cc`/`gcc` — separate from
# `crossbuild-essential-armhf` below, which only provides the ARM
# cross-toolchain. Build scripts and proc-macros (e.g. `libc`, `proc-macro2`,
# `quote`) compile and run for the host platform, not the target, so without
# a native compiler they fail with "linker `cc` not found" even though the
# actual target build only ever needs the ARM cross-compiler.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        crossbuild-essential-armhf \
        cmake \
        git \
        pkg-config \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Wires cc-rs/cmake-rs (for the bundled C/C++ builds: Opus, DuckDB) and cargo
# (for the final link) to the installed cross-toolchain.
#
# `-mfpu=neon`: the Pi 4's Cortex-A72 has a NEON SIMD unit, but this Rust
# target's generic default (`vfpv3-d16`, no NEON) doesn't assume one, since
# the target also covers ARMv7 hardfloat boards without it. Without this,
# compiling Opus's ARM NEON intrinsics file fails with "target specific
# option mismatch". Must match the `-C target-feature=+neon` rustflag in
# .cargo/config.toml.
ENV CC_armv7_unknown_linux_gnueabihf=arm-linux-gnueabihf-gcc \
    CXX_armv7_unknown_linux_gnueabihf=arm-linux-gnueabihf-g++ \
    AR_armv7_unknown_linux_gnueabihf=arm-linux-gnueabihf-ar \
    CARGO_TARGET_ARMV7_UNKNOWN_LINUX_GNUEABIHF_LINKER=arm-linux-gnueabihf-gcc \
    CFLAGS_armv7_unknown_linux_gnueabihf=-mfpu=neon \
    CXXFLAGS_armv7_unknown_linux_gnueabihf=-mfpu=neon
