---
tags: [reading, chess]
---
# Chess Programming Wiki

Key pages I keep going back to:
- Magic bitboards: the trick is a perfect hash from (occupancy & mask) * magic >> shift.
- Late move reductions: reduce depth for moves late in the ordering, re-search if they beat alpha.
- Singular extensions: extend when one move is much better than all alternatives.
