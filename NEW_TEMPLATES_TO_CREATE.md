# AiSensy Templates Reference & Creation Guide

You currently have: `nudge_1_cart`, `nudge_2nd_cart`, `nudge_3_cart`, `nudge_4_cart` + their `_b` variants.
Recently activated live: `browse_nudge_trust` (with header image) and `browse_nudge_chefpick`.

---

## Template 1: `browse_nudge_trust` (✅ LIVE in AiSensy)

**Header Media:** Image (Shopify CDN: `protein_pantry.png`)
**Used in:** Browse Abandon Tiers 3/4/5 — Variant A (Trust / Lab-Test angle) + Follow-ups

**Body:**
```
Hey {{1}} 👋

We noticed you were checking out Protein Pantry — great taste in clean protein! 💪

Here's what makes us different:

🧪 Every single batch is lab-tested and verified for protein content
🚫 No maida, no fillers, no nonsense
📊 Full macros printed on every pack — what you see is what you get

See our lab reports and shop with confidence 👇
```

**Parameters:**
- `{{1}}` = Customer First Name

**CTA Button:**
- Text: `See Lab Reports`
- URL: `https://proteinpantry.in`

---

## Template 2: `browse_nudge_chefpick` (✅ LIVE in AiSensy)

**Used in:** Browse Abandon Tiers 3/4/5 — Variant B (Chef's Picks angle) + Follow-up nudges + Reorder Nudge 2

**Body:**
```
Hey {{1}} 👋

Can't decide what to try first? Here's our Chef's Picks — the 3 products our customers love most:

🧀 Spinach Cheese Cutlet — 25g protein, real cheddar cheese
🔥 Tandoori Chaap — 38g protein, smoky & spicy
🥗 Beetroot Kebab — 27g protein, just 235 calories

All pre-marinated. Just heat & eat in 5 minutes ⏱️

Try the Chef's Picks combo 👇
```

**Parameters:**
- `{{1}}` = Customer First Name

**CTA Button:**
- Text: `Shop Chef's Picks`
- URL: `https://proteinpantry.in/products/chiefs-picks`

---

## Template 3: `browse_nudge_protein`

**Used in:** Browse Abandon Tiers 3/4/5 — Variant C (Protein Gap angle)

**Body:**
```
Hey {{1}} 👋

Quick question — are you getting enough protein? 🤔

Most Indians eat only 40-50g protein daily. The recommended amount? 80-100g.

Here's how Protein Pantry makes closing that gap effortless:

🍽️ Add 25-38g protein to ANY meal in 5 minutes
🥬 Made from real ingredients — cheese, mushrooms, chickpeas, beetroot
📦 Delivered fresh to your door

Start fixing your protein gap 👇
```

**Parameters:**
- `{{1}}` = Customer First Name

**CTA Button:**
- Text: `Shop Now`
- URL: `https://proteinpantry.in/collections/all`

---

## Template 4: `reorder_nudge_1_restock`

**Used in:** Reorder funnel — Nudge 1 (Day 15 after order)

**Body:**
```
Hey {{1}}! 👋

Hope you enjoyed your last order from Protein Pantry! 🎉

Running low on your protein stash? Restock your favourites before they run out:

🔄 Quick reorder — same items, zero hassle
📦 Same 2-day delivery you love

Reorder now 👇
```

**Parameters:**
- `{{1}}` = Customer First Name

**CTA Button:**
- Text: `Reorder Now`
- URL: `https://proteinpantry.in`

---

## Template 5: `reorder_nudge_4_winback`

**Used in:** Reorder funnel — Nudge 4 (Day 45 after order, final)

**Body:**
```
Hi {{1}},

We miss you at Protein Pantry! 😢

It's been a while since your last order. Here's what's waiting:

🔥 205g protein across our Weekly Bundle — under 2000 cal
🧪 Every batch lab-tested for purity
📦 Free delivery on orders ₹499+

Come back anytime — we'll keep it fresh for you 👇
```

**Parameters:**
- `{{1}}` = Customer First Name

**CTA Button:**
- Text: `Shop Now`
- URL: `https://proteinpantry.in`

---

## Template 6: `restock_14d_1` (14-Day Restock — Variant A)

**Used in:** Reorder funnel — Nudge 0 (Day 14 after order, A/B test)

**Body:**
```
Hey {{1}}, your Protein Pantry stash might be running low by now.

Time to bring some tasty, clean protein back into the freezer. Your next order is waiting!
```

**Parameters:**
- `{{1}}` = Customer First Name

**CTA Button:**
- Text: `Order Now`
- URL: `https://proteinpantry.in`

---

## Template 7: `restock_14d_2` (14-Day Restock — Variant B)

**Used in:** Reorder funnel — Nudge 0 (Day 14 after order, A/B test)

**Body:**
```
Hey {{1}}, it's been a little while!

Time to stock up on your Protein Pantry favourites and keep those protein goals moving. Your next tasty, high-protein order is just a few clicks away!
```

**Parameters:**
- `{{1}}` = Customer First Name

**CTA Button:**
- Text: `Order Now`
- URL: `https://proteinpantry.in`

---

## Summary: What Goes Where

```
YOUR EXISTING TEMPLATES (no action needed):
  nudge_1_cart          → Cart Tier 1 & 2 Nudge 1
  nudge_2nd_cart (+_b)  → Cart coupon + Browse T3 coupon + Reorder Day 30 coupon
  nudge_3_cart (+_b)    → Cart Tier 1 free shipping
  nudge_4_cart (+_b)    → Cart Tier 1 & 2 urgency

NEW TEMPLATES (create these 7):
  browse_nudge_trust      → Browse T3/T4/T5 Nudge 1 (Variant A) + T4/T5 follow-up
  browse_nudge_chefpick   → Browse T3/T4/T5 Nudge 1 (Variant B) + all follow-ups + Reorder Day 22
  browse_nudge_protein    → Browse T3/T4/T5 Nudge 1 (Variant C)
  restock_14d_1           → Reorder Day 14 (A/B Variant A) ← NEW
  restock_14d_2           → Reorder Day 14 (A/B Variant B) ← NEW
  reorder_nudge_1_restock → Reorder Day 15
  reorder_nudge_4_winback → Reorder Day 45
```
