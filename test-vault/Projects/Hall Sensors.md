---
tags: [project, hardware]
---
# Hall Sensors

Notes on the piece-detection layer of the [[Chess Robot]].

Each square has one A3144 hall effect sensor. Every piece has a small neodymium magnet glued into its base. The sensors are digital (open collector) so we read them through four 16-channel multiplexers into the Pi GPIO.

Polling rate is 50 Hz. Debounce by requiring 3 consecutive identical reads.

## Lessons
- Magnets must all be oriented the same way or some pieces never register.
- The sensor only sees the magnet when it is within ~4 mm; thin bases need a stronger magnet.
- Cheap: about $0.10 per sensor in bulk.
