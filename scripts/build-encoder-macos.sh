#!/usr/bin/env bash
set -euo pipefail
ffmpeg_archive=$1
lame_archive=$2
build_root=$3
encoder_target=$4
encoder_output=$5
license_output=$6
mkdir -p "$build_root" "$license_output"
tar -xzf "$ffmpeg_archive" -C "$build_root"
tar -xzf "$lame_archive" -C "$build_root"
encoder_arch=x86_64
clang_arch=x86_64
if [[ "$encoder_target" == aarch64-apple-darwin ]]; then
  encoder_arch=aarch64
  clang_arch=arm64
fi
encoder_prefix="$build_root/prefix"
encoder_flags="-arch $clang_arch -mmacosx-version-min=12.0"
jobs=$(sysctl -n hw.logicalcpu)
cd "$build_root/lame-4.0"
ac_cv_prog_cc_c23=no CC=clang CFLAGS="$encoder_flags -O2 -std=gnu11 -Wno-implicit-function-declaration" LDFLAGS="$encoder_flags" \
  ./configure --host="$encoder_arch-apple-darwin" --prefix="$encoder_prefix" --disable-shared --enable-static --disable-frontend --disable-decoder --disable-dependency-tracking
make -j "$jobs"
make install
cp COPYING "$license_output/LAME-LICENSE.txt"
cd "$build_root/FFmpeg-n9.0.2"
./configure --prefix="$encoder_prefix" --target-os=darwin --arch="$encoder_arch" --enable-cross-compile --cc=clang \
  --extra-cflags="$encoder_flags -I$encoder_prefix/include" --extra-ldflags="$encoder_flags -L$encoder_prefix/lib" \
  --disable-autodetect --disable-shared --enable-static --disable-doc --disable-debug --disable-x86asm \
  --disable-everything --enable-ffmpeg --disable-ffplay --enable-ffprobe --enable-avcodec --enable-avformat --enable-avfilter --enable-swresample \
  --enable-libmp3lame --enable-zlib --enable-encoder=libmp3lame,aac,pcm_s16le \
  --enable-decoder=pcm_s16le,mp3,mp3float,aac,mjpeg,png --enable-parser=mpegaudio,aac,mjpeg,png \
  --enable-demuxer=pcm_s16le,image2,mov,mp3,wav,aac --enable-muxer=mp3,ipod,wav,pcm_s16le,null \
  --enable-protocol=file,pipe --enable-filter=aresample,aformat,anull
make -j "$jobs"
cp ffmpeg "$encoder_output"
cp COPYING.LGPLv2.1 "$license_output/FFmpeg-LICENSE.txt"
