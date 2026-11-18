//! Line-oriented worker: one JSON request per line, one JSON response per line.
//!
//! The TypeScript side keeps this process alive and writes requests to stdin,
//! which removes per-call process startup from the hot path.

use std::io::{BufRead, Write};

use depth_rs::decimal::Decimal;
use depth_rs::port;
use depth_rs::protocol::{DepthResultOut, Request, SimulateOut};

fn handle(request: Request) -> Result<serde_json::Value, String> {
    match request {
        Request::BuyByQuote { book, amount } => {
            let out = port::calculate_buy_depth_by_quote(&book.asks()?, &Decimal::parse(&amount)?)?;
            Ok(serde_json::to_value(DepthResultOut::from(out)).map_err(|e| e.to_string())?)
        }
        Request::BuyByBase { book, amount } => {
            let out = port::calculate_buy_depth_by_base(&book.asks()?, &Decimal::parse(&amount)?)?;
            Ok(serde_json::to_value(DepthResultOut::from(out)).map_err(|e| e.to_string())?)
        }
        Request::SellByBase { book, amount } => {
            let out = port::calculate_sell_depth_by_base(&book.bids()?, &Decimal::parse(&amount)?)?;
            Ok(serde_json::to_value(DepthResultOut::from(out)).map_err(|e| e.to_string())?)
        }
        Request::SellByQuote { book, amount } => {
            let out = port::calculate_sell_depth_by_quote(&book.bids()?, &Decimal::parse(&amount)?)?;
            Ok(serde_json::to_value(DepthResultOut::from(out)).map_err(|e| e.to_string())?)
        }
        Request::Simulate {
            buy_book,
            sell_book,
            amount,
        } => {
            let (buy, sell) = port::simulate_two_leg_base_amount(
                &buy_book.asks()?,
                &sell_book.bids()?,
                &Decimal::parse(&amount)?,
            )?;
            Ok(serde_json::to_value(SimulateOut {
                buy: DepthResultOut::from(buy),
                sell: DepthResultOut::from(sell),
            })
            .map_err(|e| e.to_string())?)
        }
        Request::Ping => Ok(serde_json::json!({ "pong": true })),
    }
}

fn main() {
    let stdin = std::io::stdin();
    let mut stdout = std::io::BufWriter::new(std::io::stdout().lock());
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Request>(&line) {
            Ok(request) => match handle(request) {
                Ok(result) => serde_json::json!({ "ok": result }),
                Err(error) => serde_json::json!({ "error": error }),
            },
            Err(error) => serde_json::json!({ "error": format!("invalid request: {error}") }),
        };
        if serde_json::to_writer(&mut stdout, &response).is_err() {
            break;
        }
        if stdout.write_all(b"\n").is_err() || stdout.flush().is_err() {
            break;
        }
    }
}
