---
tags: [project, chess, programming]
---
# Engine Notes

The engine behind the [[Chess Robot]].

- Magic bitboards for sliding piece attacks
- Iterative deepening with aspiration windows
- Transposition table, 256 MB default
- NNUE evaluation with a custom .knnue format; the Python training pipeline lives in tools/
- Time management: Slow Mover and Move Overhead knobs exposed as UCI options

Strength changes must be validated with SPRT, not eyeballed. A 2000-game run at 200k nodes/move is the standard test.

Related: [[Reading/Chess Programming Wiki]]
