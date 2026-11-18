//! Rust port of `packages/core/src/depth.ts`.
//!
//! Behaviour must match the TypeScript original exactly; `rust/depth-rs/cases.jsonl`
//! holds 28,200 cases recorded from production order books.

#![forbid(unsafe_code)]


use crate::decimal::Decimal;

#[derive(Clone, Debug, PartialEq)]
pub struct DepthLevel {
    pub price: Decimal,
    pub amount: Decimal,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BookSide {
    pub levels: Vec<DepthLevel>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Buy,
    Sell,
}

impl Side {
    pub fn as_str(self) -> &'static str {
        match self {
            Side::Buy => "buy",
            Side::Sell => "sell",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DepthResult {
    pub side: Side,
    pub requested_notional: Decimal,
    pub executable_base_amount: Decimal,
    pub executable_quote_amount: Decimal,
    pub average_price: Decimal,
    pub worst_price: Decimal,
    pub levels_consumed: usize,
    pub insufficient_depth: bool,
}

/// Port of `calculateBuyDepthByQuote` (depth.ts:4).
pub fn calculate_buy_depth_by_quote(
    asks: &BookSide,
    requested_quote: &Decimal,
) -> Result<DepthResult, String> {
    if !requested_quote.is_positive() {
        return Err("requestedQuote must be positive".to_string());
    }
    let mut remaining_quote = requested_quote.clone();
    let mut base = Decimal::zero();
    let mut quote = Decimal::zero();
    let mut worst = Decimal::zero();
    let mut consumed = 0usize;
    for level in &asks.levels {
        if !remaining_quote.gt(&Decimal::zero()) {
            break;
        }
        let level_quote = level.price.mul(&level.amount);
        let spend = remaining_quote.min(&level_quote);
        base = base.add(&spend.div(&level.price)?);
        quote = quote.add(&spend);
        remaining_quote = remaining_quote.sub(&spend);
        worst = level.price.clone();
        consumed += 1;
    }
    let average_price = if base.gt(&Decimal::zero()) {
        quote.div(&base)?
    } else {
        Decimal::zero()
    };
    Ok(DepthResult {
        side: Side::Buy,
        requested_notional: requested_quote.clone(),
        executable_base_amount: base,
        executable_quote_amount: quote,
        average_price,
        worst_price: worst,
        levels_consumed: consumed,
        insufficient_depth: remaining_quote.gt(&Decimal::zero()),
    })
}

/// Port of `calculateBuyDepthByBase` (depth.ts:36).
pub fn calculate_buy_depth_by_base(
    asks: &BookSide,
    requested_base: &Decimal,
) -> Result<DepthResult, String> {
    if !requested_base.is_positive() {
        return Err("requestedBase must be positive".to_string());
    }
    let mut remaining_base = requested_base.clone();
    let mut base = Decimal::zero();
    let mut quote = Decimal::zero();
    let mut worst = Decimal::zero();
    let mut consumed = 0usize;
    for level in &asks.levels {
        if !remaining_base.gt(&Decimal::zero()) {
            break;
        }
        let take = remaining_base.min(&level.amount);
        base = base.add(&take);
        quote = quote.add(&take.mul(&level.price));
        remaining_base = remaining_base.sub(&take);
        worst = level.price.clone();
        consumed += 1;
    }
    let average_price = if base.gt(&Decimal::zero()) {
        quote.div(&base)?
    } else {
        Decimal::zero()
    };
    Ok(DepthResult {
        side: Side::Buy,
        requested_notional: quote.clone(),
        executable_base_amount: base,
        executable_quote_amount: quote,
        average_price,
        worst_price: worst,
        levels_consumed: consumed,
        insufficient_depth: remaining_base.gt(&Decimal::zero()),
    })
}

/// Port of `calculateSellDepthByBase` (depth.ts:67).
pub fn calculate_sell_depth_by_base(
    bids: &BookSide,
    requested_base: &Decimal,
) -> Result<DepthResult, String> {
    if !requested_base.is_positive() {
        return Err("requestedBase must be positive".to_string());
    }
    let mut remaining_base = requested_base.clone();
    let mut base = Decimal::zero();
    let mut quote = Decimal::zero();
    let mut worst = Decimal::zero();
    let mut consumed = 0usize;
    for level in &bids.levels {
        if !remaining_base.gt(&Decimal::zero()) {
            break;
        }
        let take = remaining_base.min(&level.amount);
        base = base.add(&take);
        quote = quote.add(&take.mul(&level.price));
        remaining_base = remaining_base.sub(&take);
        worst = level.price.clone();
        consumed += 1;
    }
    let average_price = if base.gt(&Decimal::zero()) {
        quote.div(&base)?
    } else {
        Decimal::zero()
    };
    Ok(DepthResult {
        side: Side::Sell,
        requested_notional: quote.clone(),
        executable_base_amount: base,
        executable_quote_amount: quote,
        average_price,
        worst_price: worst,
        levels_consumed: consumed,
        insufficient_depth: remaining_base.gt(&Decimal::zero()),
    })
}

/// Port of `calculateSellDepthByQuote` (depth.ts:98).
pub fn calculate_sell_depth_by_quote(
    bids: &BookSide,
    requested_quote: &Decimal,
) -> Result<DepthResult, String> {
    if !requested_quote.is_positive() {
        return Err("requestedQuote must be positive".to_string());
    }
    let mut remaining_quote = requested_quote.clone();
    let mut base = Decimal::zero();
    let mut quote = Decimal::zero();
    let mut worst = Decimal::zero();
    let mut consumed = 0usize;
    for level in &bids.levels {
        if !remaining_quote.gt(&Decimal::zero()) {
            break;
        }
        let level_quote = level.price.mul(&level.amount);
        let take_quote = remaining_quote.min(&level_quote);
        base = base.add(&take_quote.div(&level.price)?);
        quote = quote.add(&take_quote);
        remaining_quote = remaining_quote.sub(&take_quote);
        worst = level.price.clone();
        consumed += 1;
    }
    let average_price = if base.gt(&Decimal::zero()) {
        quote.div(&base)?
    } else {
        Decimal::zero()
    };
    Ok(DepthResult {
        side: Side::Sell,
        requested_notional: requested_quote.clone(),
        executable_base_amount: base,
        executable_quote_amount: quote,
        average_price,
        worst_price: worst,
        levels_consumed: consumed,
        insufficient_depth: remaining_quote.gt(&Decimal::zero()),
    })
}

/// Port of `simulateTwoLegBaseAmount` (depth.ts:130).
pub fn simulate_two_leg_base_amount(
    buy_asks: &BookSide,
    sell_bids: &BookSide,
    requested_quote: &Decimal,
) -> Result<(DepthResult, DepthResult), String> {
    let buy = calculate_buy_depth_by_quote(buy_asks, requested_quote)?;
    let sell = calculate_sell_depth_by_base(sell_bids, &buy.executable_base_amount)?;
    Ok((buy, sell))
}


