---
name: Self-contained Raspberry Pi edition
description: User's intended Pi product hosts the dashboard locally, not just a kiosk for TrueNAS.
---

The Pi edition must host the Tachboard instance on the Pi as well as display it full screen, with the instance available to the local network. It should be a separate download that does not require a TrueNAS host.

**Why:** the user clarified that independent hosting was the reason they considered a separate fork; a TrueNAS-hosted dashboard plus Pi browser does not meet that goal.

**How to apply:** include local server hosting in the initial Pi scope. The user chose network connectivity first with USB support eventually. Shared code with separate packaging is a recommendation, not permission to remove the standalone-hosting requirement. The earlier draft excluded a self-contained Pi installer and needs revision before execution.