---
tags: [project, robotics]
status: active
---
# Chess Robot

An autonomous chess board that physically moves pieces. The engine runs on a Raspberry Pi and a gantry under the board moves pieces with an electromagnet.

## Hardware
- XY gantry driven by two NEMA 17 steppers, GRBL firmware over serial
- Electromagnet on the carriage, switched with M8/M9 G-code commands
- 64 [[Hall Sensors|hall effect sensors]] under the squares detect piece presence
- OLED display and three buttons for the UI

## Software
- Custom C++ engine (bitboards, alpha-beta, NNUE eval) — see [[Engine Notes]]
- `BoardInterpreter` plans piece paths and parks blockers
- Captured pieces are routed to storage slots along the edge

## Open problems
- Knight moves need a path through the gaps between squares; currently using a half-square offset trick
- Magnet sometimes drags an adjacent piece when it passes close by. Need to tune current or route further from neighbours.
- Calibration drifts after ~200 moves, see [[2026-01-14]]
