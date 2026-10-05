---
name: Self-contained Raspberry Pi edition
description: User's intended Pi product hosts the dashboard locally, not just a kiosk for TrueNAS.
---

The Pi edition must support standalone hosting on the Pi as well as full-screen display, with the instance available to the local network. It should be a separate download that does not require a TrueNAS host. It must also support a TrueNAS-hosted instance with the Pi acting as a kiosk; both deployment options must coexist.

**Why:** the user clarified that independent hosting was the reason they considered a separate fork, then explicitly retained the TrueNAS + Pi kiosk option. Neither deployment option should replace the other.

**How to apply:** include local server hosting and an external-server kiosk configuration in the initial Pi scope, sharing Tachboard code with separate Pi packaging as the user agreed. The user chose network connectivity first with USB support eventually. The earlier draft excluded a self-contained Pi installer and needs revision before execution.

Use Raspberry Pi OS Desktop Trixie (64-bit) as the initial native-bundle baseline; do not casually broaden support to Bookworm.

**Why:** release native dependencies are built on Ubuntu 24.04 ARM64, whose glibc can be newer than Bookworm's. Sharing the application code does not guarantee shared native-binary compatibility.

**How to apply:** test native SQLite/image dependencies on any newly supported OS, and distinguish portable installer/packaging tests from real Pi boot/display verification.