//! JSON-line protocol between the TypeScript hot path and the Rust worker.
//!
//! Decimal values cross the process boundary as strings so that no precision is
//! lost between `decimal.js` and `bigdecimal`.

use serde::{Deserialize, Serialize};

use crate::decimal::Decimal;
use crate::port::{BookSide, DepthLevel, DepthResult};

#[derive(Clone, Debug, Deserialize)]
pub struct LevelIn {
    pub price: String,
    pub amount: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct BookIn {
    #[serde(default)]
    pub asks: Vec<LevelIn>,
    #[serde(default)]
    pub bids: Vec<LevelIn>,
}

impl BookIn {
    fn side(rows: &[LevelIn]) -> Result<BookSide, String> {
        let mut levels = Vec::with_capacity(rows.len());
        for row in rows {
            levels.push(DepthLevel {
                price: Decimal::parse(&row.price)?,
                amount: Decimal::parse(&row.amount)?,
            });
        }
        Ok(BookSide { levels })
    }

    pub fn asks(&self) -> Result<BookSide, String> {
        Self::side(&self.asks)
    }

    pub fn bids(&self) -> Result<BookSide, String> {
        Self::side(&self.bids)
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct DepthResultOut {
    pub side: &'static str,
    #[serde(rename = "requestedNotional")]
    pub requested_notional: String,
    #[serde(rename = "executableBaseAmount")]
    pub executable_base_amount: String,
    #[serde(rename = "executableQuoteAmount")]
    pub executable_quote_amount: String,
    #[serde(rename = "averagePrice")]
    pub average_price: String,
    #[serde(rename = "worstPrice")]
    pub worst_price: String,
    #[serde(rename = "levelsConsumed")]
    pub levels_consumed: usize,
    #[serde(rename = "insufficientDepth")]
    pub insufficient_depth: bool,
}

impl From<DepthResult> for DepthResultOut {
    fn from(value: DepthResult) -> Self {
        Self {
            side: value.side.as_str(),
            requested_notional: value.requested_notional.to_plain_string(),
            executable_base_amount: value.executable_base_amount.to_plain_string(),
            executable_quote_amount: value.executable_quote_amount.to_plain_string(),
            average_price: value.average_price.to_plain_string(),
            worst_price: value.worst_price.to_plain_string(),
            levels_consumed: value.levels_consumed,
            insufficient_depth: value.insufficient_depth,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "op")]
pub enum Request {
    #[serde(rename = "buyByQuote")]
    BuyByQuote { book: BookIn, amount: String },
    #[serde(rename = "buyByBase")]
    BuyByBase { book: BookIn, amount: String },
    #[serde(rename = "sellByBase")]
    SellByBase { book: BookIn, amount: String },
    #[serde(rename = "sellByQuote")]
    SellByQuote { book: BookIn, amount: String },
    #[serde(rename = "simulate")]
    Simulate {
        #[serde(rename = "buyBook")]
        buy_book: BookIn,
        #[serde(rename = "sellBook")]
        sell_book: BookIn,
        amount: String,
    },
    #[serde(rename = "ping")]
    Ping,
}

#[derive(Clone, Debug, Serialize)]
pub struct SimulateOut {
    pub buy: DepthResultOut,
    pub sell: DepthResultOut,
}

