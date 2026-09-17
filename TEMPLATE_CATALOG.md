# Protein Pantry — Current WhatsApp Template Catalog & Flow

## All Current AiSensy Templates

### Category 1: Cart Abandon Templates (Live ✅)

---

#### `nudge_1_cart` — Cart Reminder (Nudge 1)
- **Status**: 🟢 Live | **Sent**: 945
- **Params**: `{{1}}` = Name, `{{2}}` = Cart Items
- **CTA**: "Complete Now"
```
Hey {{1}}, you left {{2}} in your cart! 🛒

Your fresh batch is currently reserved, but stock moves fast.
Tap below to finish your order:
```
> **Verdict**: ❌ Cart-specific ("you left X in your cart") — cannot reuse for browse/reorder

---

#### `nudge_2nd_cart` — PRO10 Coupon (Nudge 2 · Variant A)
- **Status**: 🟢 Live | **Sent**: 719
- **Params**: `{{1}}` = Name, `{{2}}` = Coupon Code
- **CTA**: "Claim 10% Off"
```
Hey {{1}}! 👋

We know how difficult it is to stay consistent with your protein goals
— but stocking up on clean, tasty food from Protein Pantry shouldn't be!

Here is a sweet 10% OFF on your order:
Use code: {{2}} at checkout.

Tap below to complete your order before it expires:
```
> **Verdict**: ✅ REUSABLE! Messaging is about "protein goals" and "stocking up" — generic enough for browse abandon coupon AND reorder loyalty coupon. Only "complete your order" is slightly cart-ish but still works.

---

#### `nudge_2nd_cart_b` — PRO10 Coupon (Nudge 2 · Variant B)
- **Status**: 🟢 Live | **Sent**: 156
- **Params**: `{{1}}` = Name, `{{2}}` = Coupon Code
- **CTA**: (A/B variant of nudge_2nd_cart)
> **Verdict**: ✅ Same as above — reusable if Variant A is reusable

---

#### `nudge_3_cart` — FREEDEL Free Shipping (Nudge 3 · Variant A)
- **Status**: 🟢 Live | **Sent**: 693
- **Params**: `{{1}}` = Name, `{{2}}` = Coupon Code
- **CTA**: "Get Free Shipping"
```
Hey {{1}}, looks like your Protein Pantry pack is waiting for you! 👀

Here's a little push — we'll cover the shipping charges! 🚚

Use code: {{2}} to get 100% FREE Shipping on your cart.

Valid for the next 24 hours only:
```
> **Verdict**: ⚠️ Semi-reusable. Says "FREE Shipping on your cart" — works for cart, borderline for browse. Not ideal for reorder.

---

#### `nudge_3rd_cart_b` — FREEDEL Free Shipping (Nudge 3 · Variant B)
- **Status**: 🟢 Live | **Sent**: 126
> **Verdict**: Same as nudge_3_cart

---

#### `nudge_4_cart` — Scarcity/Urgency (Nudge 4 · Variant A)
- **Status**: ⏸️ Paused | **Sent**: 5
- **Params**: `{{1}}` = Name
- **CTA**: "Order Before Sold Out"
```
Hey {{1}}, your protein stack is waiting on you! 💪

Don't let all that clean protein sit in your cart.
Grab your favourites now before your cart reservation and discount expire:
```
> **Verdict**: ❌ Very cart-specific ("sit in your cart," "cart reservation") — cannot reuse

---

#### `nudge_4_cart_b` — Scarcity/Urgency (Nudge 4 · Variant B)
- **Status**: 🟢 Live | **Sent**: 0
> **Verdict**: Same as nudge_4_cart — cart-specific

---

#### `nudge_2_cart` — Old Version (Deprecated)
- **Status**: 🔴 Stopped | **Sent**: 8
> Replaced by `nudge_2nd_cart`. No longer used.

---

### Category 2: Browse Abandon Templates

| Template | Angle | Status |
|----------|-------|--------|
| `browse_nudge_trust` | Lab-test credibility (Header Image) | ✅ LIVE in AiSensy |
| `browse_nudge_chefpick` | Chef's Picks recommendation | ✅ LIVE in AiSensy |
| `browse_nudge_protein` | Protein gap education | ⚠️ In Review / Optional (Falls back to `browse_nudge_chefpick`) |

### Category 3: Reorder Templates

#### `restock_14d_1` — 14-Day Restock (Variant A)
- **Status**: 🆕 New | **Sent**: 0
- **Params**: `{{1}}` = Name
- **CTA**: "Order Now"
```
Hey {{1}}, your Protein Pantry stash might be running low by now.

Time to bring some tasty, clean protein back into the freezer. Your next order is waiting!
```
> **Used in**: Reorder Nudge 0 (Day 14) — A/B Variant A

---

#### `restock_14d_2` — 14-Day Restock (Variant B)
- **Status**: 🆕 New | **Sent**: 0
- **Params**: `{{1}}` = Name
- **CTA**: "Order Now"
```
Hey {{1}}, it's been a little while!

Time to stock up on your Protein Pantry favourites and keep those protein goals moving. Your next tasty, high-protein order is just a few clicks away!
```
> **Used in**: Reorder Nudge 0 (Day 14) — A/B Variant B

---

## Current Nudge Sequences (What Fires Today)

### Tier 1: Checkout Abandoner (Very High Intent)
```
Customer abandons checkout
    │
    ├── T+30 min ──→ nudge_1_cart     "You left [items] in your cart"
    ├── T+4 hrs ───→ nudge_2nd_cart   "10% OFF with PRO10" (A/B test, skip returning)
    ├── T+24 hrs ──→ nudge_3_cart     "Free shipping with FREEDEL" (A/B test, skip returning)
    └── T+72 hrs ──→ nudge_4_cart     "Cart reservation expiring" (A/B test)
```

### Tier 2: Cart Adder (High Intent)
```
Customer adds to cart but doesn't checkout
    │
    ├── T+2 hrs ───→ nudge_1_cart     "You left [items] in your cart"
    ├── T+24 hrs ──→ nudge_2nd_cart   "10% OFF with PRO10" (A/B test, skip returning)
    └── T+5 days ──→ nudge_4_cart     "Last chance" (A/B test)
```

### Tier 3: Product Browser (Medium Intent)
```
Customer viewed product pages only
    │
    ├── T+24 hrs ──→ browse_nudge_trust/chefpick/protein  (A/B/C test)
    ├── T+72 hrs ──→ nudge_2nd_cart                        (PRO10 coupon, skip returning)
    └── T+5 days ──→ browse_nudge_bestseller               (NEW — needs creation)
```

### Tier 4: Collection Browser (Low Intent)
```
Customer viewed collection pages only
    │
    ├── T+48 hrs ──→ browse_nudge_trust/chefpick/protein  (A/B/C test)
    ├── T+4 days ──→ browse_nudge_bestseller               (NEW — needs creation)
    └── T+7 days ──→ browse_nudge_social_proof             (NEW — needs creation)
```

### Tier 5: Store Visitor (Very Low Intent)
```
Customer only visited the store
    │
    ├── T+7 days ──→ browse_nudge_trust/chefpick/protein  (A/B/C test)
    ├── T+10 days ─→ browse_nudge_bestseller               (NEW — needs creation)
    └── T+14 days ─→ browse_nudge_social_proof             (NEW — needs creation)
```

### Tier 0: Reorder (Past Buyer)
```
Customer placed an order
    │
    ├── T+14 days ─→ restock_14d_1 / restock_14d_2        (NEW — A/B test)
    ├── T+15 days ─→ reorder_nudge_1_restock               (NEW — needs creation)
    ├── T+22 days ─→ reorder_nudge_2_new_arrival           (NEW — needs creation)
    ├── T+30 days ─→ reorder_nudge_3_loyalty               (NEW — needs creation)
    └── T+45 days ─→ reorder_nudge_4_winback               (NEW — needs creation)
```

---

## Reusability Analysis — Can We Cut New Templates?

Looking at the actual body text, here's what can be reused:

| Reorder Nudge | Can Reuse? | Existing Template | Why / Why Not |
|---------------|-----------|-------------------|---------------|
| R-N1 Restock | ❌ No | — | No existing "time to restock" template |
| R-N2 New Arrival | ✅ Yes | `browse_nudge_chefpick` | Same Chef's Picks recommendation, same `{{1}}` param |
| R-N3 Loyalty Coupon | ✅ Yes | `nudge_2nd_cart` | Generic "protein goals + coupon" messaging works for reorder |
| R-N4 Win-back | ❌ No | — | No existing "we miss you" template |

| Browse Follow-up | Can Reuse? | Existing Template | Why / Why Not |
|-----------------|-----------|-------------------|---------------|
| Bestseller | ✅ Yes | `browse_nudge_chefpick` | Same product recommendation angle |
| Social Proof | ✅ Yes | `browse_nudge_trust` | Same credibility/trust angle |

### After Reuse Optimization

**Templates that truly need to be created in AiSensy:**

| # | Template | Category | Why Can't Reuse |
|---|----------|----------|----------------|
| 1 | `browse_nudge_trust` | Browse A/B/C | No existing trust/lab-test template |
| 2 | `browse_nudge_chefpick` | Browse A/B/C | No existing product recommendation template |
| 3 | `browse_nudge_protein` | Browse A/B/C | No existing protein education template |
| 4 | `reorder_nudge_1_restock` | Reorder | No existing restock reminder |
| 5 | `reorder_nudge_4_winback` | Reorder | No existing win-back template |

**Total: 5 new templates** (down from 9 originally), with 2 reorder nudges reusing existing browse templates.
