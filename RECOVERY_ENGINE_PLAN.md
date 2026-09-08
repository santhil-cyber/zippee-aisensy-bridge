# Unified 3-Category WhatsApp Recovery Engine — Updated Plan

## Template Strategy: Maximum Reuse

After reviewing the actual body text of all live AiSensy templates, here's the optimized approach:

### Existing Live Templates (7 cart + 1 confirmation)

| Template | Body Text | Reusable? |
|----------|-----------|-----------|
| `nudge_1_cart` | "you left {{2}} in your cart! 🛒" | ❌ Cart-specific |
| `nudge_2nd_cart` | "protein goals... 10% OFF... code: {{2}}" | ✅ **Generic enough** — reuse for reorder coupon |
| `nudge_2nd_cart_b` | Variant B of above | ✅ Same |
| `nudge_3_cart` | "FREE Shipping on your cart" | ⚠️ Says "your cart" |
| `nudge_3rd_cart_b` | Variant B of above | ⚠️ Same |
| `nudge_4_cart` | "protein sit in your cart... cart reservation expire" | ❌ Very cart-specific |
| `nudge_4_cart_b` | Variant B of above | ❌ Same |

### Templates That Need Creation: 5 Total

| # | Template | Used In | Body Copy |
|---|----------|---------|-----------|
| 1 | `browse_nudge_trust` | Browse T3/T4/T5 Nudge 1 (Variant A) + T4/T5 Nudge 3 | Lab-test credibility angle |
| 2 | `browse_nudge_chefpick` | Browse T3/T4/T5 Nudge 1 (Variant B) + T3/T4/T5 follow-ups + Reorder Nudge 2 | Chef's Picks recommendation |
| 3 | `browse_nudge_protein` | Browse T3/T4/T5 Nudge 1 (Variant C) | Protein gap education |
| 4 | `reorder_nudge_1_restock` | Reorder Nudge 1 (Day 15) | "Running low? Restock" |
| 5 | `reorder_nudge_4_winback` | Reorder Nudge 4 (Day 45) | "We miss you" win-back |

### Reuse Map (No New Template Needed)

| Sequence Step | Reuses | Why It Works |
|---------------|--------|-------------|
| Reorder N2 (Day 22) | `browse_nudge_chefpick` | Same Chef's Picks product recommendation |
| Reorder N3 (Day 30) | `nudge_2nd_cart` with `COMEBACK10` | Generic "protein goals + coupon" messaging |
| Browse T3 N3 (Day 5) | `browse_nudge_chefpick` | Rotate as follow-up |
| Browse T4 N2 (Day 4) | `browse_nudge_chefpick` | Rotate as follow-up |
| Browse T4 N3 (Day 7) | `browse_nudge_trust` | Rotate as follow-up |
| Browse T5 N2 (Day 10) | `browse_nudge_chefpick` | Rotate as follow-up |
| Browse T5 N3 (Day 14) | `browse_nudge_trust` | Rotate as follow-up |

---

## Complete Updated Flow — All 3 Categories

### Category 1: Cart Abandon (LIVE ✅ — No Changes)

**Tier 1: Checkout Abandoner**
```
T+30 min ──→ nudge_1_cart        "You left [items] in your cart"
T+4 hrs  ──→ nudge_2nd_cart      "10% OFF with PRO10" (A/B test)
T+24 hrs ──→ nudge_3_cart        "Free shipping with FREEDEL" (A/B test)
T+72 hrs ──→ nudge_4_cart        "Cart reservation expiring" (A/B test)
```

**Tier 2: Cart Adder**
```
T+2 hrs  ──→ nudge_1_cart        "You left [items] in your cart"
T+24 hrs ──→ nudge_2nd_cart      "10% OFF with PRO10" (A/B test)
T+5 days ──→ nudge_4_cart        "Last chance" (A/B test)
```

### Category 2: Browse Abandon (UPDATED 🔧)

**Tier 3: Product Browser** (3 nudges)
```
T+24 hrs ──→ browse_nudge_trust/chefpick/protein   A/B/C test
T+72 hrs ──→ nudge_2nd_cart                         PRO10 coupon (REUSE ✅)
T+5 days ──→ browse_nudge_chefpick                  Chef's Picks follow-up (REUSE ✅)
```

**Tier 4: Collection Browser** (3 nudges)
```
T+48 hrs ──→ browse_nudge_trust/chefpick/protein   A/B/C test
T+4 days ──→ browse_nudge_chefpick                  Chef's Picks follow-up (REUSE ✅)
T+7 days ──→ browse_nudge_trust                     Trust follow-up (REUSE ✅)
```

**Tier 5: Store Visitor** (3 nudges)
```
T+7 days  ──→ browse_nudge_trust/chefpick/protein  A/B/C test
T+10 days ──→ browse_nudge_chefpick                 Chef's Picks follow-up (REUSE ✅)
T+14 days ──→ browse_nudge_trust                    Trust follow-up (REUSE ✅)
```

### Category 3: Reorder — Past Buyers (NEW 🆕)

```
T+15 days ──→ reorder_nudge_1_restock    "Running low? Restock" (NEW)
T+22 days ──→ browse_nudge_chefpick      Chef's Picks upsell (REUSE ✅)
T+30 days ──→ nudge_2nd_cart             "10% OFF with COMEBACK10" (REUSE ✅)
T+45 days ──→ reorder_nudge_4_winback    "We miss you" (NEW)
```

---

## Code Changes Completed ✅

All code changes are already implemented. Files modified:

1. **classifier.js** — Added TIER_0_REORDER + deepened browse sequences (reusing existing templates)
2. **db.js** — Added `order_count`, `last_order_date`, `saveLeadForReorder()`
3. **order-confirmation.js** — Enqueues reorder nudge 1 after order confirmation
4. **shopflo-webhook.js** — Enqueues reorder on Shopflo buyer events
5. **cron-retarget.js** — Enqueues reorder when cron detects Shopify purchase (with infinite-loop guard)

---

## AiSensy Template Body Copy (Only the 2 New Reorder Templates)

### `reorder_nudge_1_restock` (Day 15)
```
Hey {{1}}! 👋

Hope you enjoyed your last order from Protein Pantry! 🎉

Running low on your protein stash? Restock your favourites before they run out:

🔄 Quick reorder — same items, zero hassle
📦 Same 2-day delivery you love

Reorder now 👇
```
- Params: `{{1}}` = Name
- CTA Button: "Reorder Now" → `proteinpantry.in`

### `reorder_nudge_4_winback` (Day 45)
```
Hi {{1}},

We miss you at Protein Pantry! 😢

It's been a while since your last order. Here's what's waiting:

🔥 205g protein across our Weekly Bundle — under 2000 cal
🧪 Every batch lab-tested for purity
📦 Free delivery on orders ₹499+

Come back anytime — we'll keep it fresh for you 👇
```
- Params: `{{1}}` = Name
- CTA Button: "Shop Now" → `proteinpantry.in`

> The 3 browse templates (trust, chefpick, protein) also need creation but were already planned before this update.
