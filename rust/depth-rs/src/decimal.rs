//! Decimal arithmetic matching decimal.js with precision 40 and ROUND_HALF_EVEN.
//!
//! decimal.js rounds the result of every operation to `precision` significant
//! digits. `bigdecimal` only rounds inside a `Context`, and its default
//! division precision is 100 digits, so every operation here explicitly rounds
//! back to 40 significant digits.

use bigdecimal::{BigDecimal, RoundingMode, Zero};
use std::str::FromStr;

pub const PRECISION: u64 = 40;
pub const ROUNDING: RoundingMode = RoundingMode::HalfEven;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decimal(BigDecimal);

impl Decimal {
    pub fn zero() -> Self {
        Decimal(BigDecimal::from(0))
    }

    pub fn parse(raw: &str) -> Result<Self, String> {
        let text = raw.trim();
        if text.is_empty() {
            return Err("invalid decimal: empty".to_string());
        }
        BigDecimal::from_str(text)
            .map(Decimal)
            .map_err(|_| format!("invalid decimal: {raw}"))
    }

    fn rounded(value: BigDecimal) -> Self {
        Decimal(value.with_precision_round(
            std::num::NonZeroU64::new(PRECISION).expect("non-zero precision"),
            ROUNDING,
        ))
    }

    pub fn add(&self, other: &Decimal) -> Self {
        Self::rounded(&self.0 + &other.0)
    }

    pub fn sub(&self, other: &Decimal) -> Self {
        Self::rounded(&self.0 - &other.0)
    }

    pub fn mul(&self, other: &Decimal) -> Self {
        Self::rounded(&self.0 * &other.0)
    }

    pub fn div(&self, other: &Decimal) -> Result<Self, String> {
        if other.0.is_zero() {
            return Err("division by zero".to_string());
        }
        Ok(Self::rounded(&self.0 / &other.0))
    }

    pub fn gt(&self, other: &Decimal) -> bool {
        self.0 > other.0
    }

    pub fn gte(&self, other: &Decimal) -> bool {
        self.0 >= other.0
    }

    pub fn lt(&self, other: &Decimal) -> bool {
        self.0 < other.0
    }

    pub fn lte(&self, other: &Decimal) -> bool {
        self.0 <= other.0
    }

    pub fn is_zero(&self) -> bool {
        self.0.is_zero()
    }

    pub fn is_positive(&self) -> bool {
        self.0 > BigDecimal::from(0)
    }

    pub fn min(&self, other: &Decimal) -> Decimal {
        if self.lte(other) {
            self.clone()
        } else {
            other.clone()
        }
    }

    /// decimal.js `toString()`: plain notation without trailing zeros.
    pub fn to_plain_string(&self) -> String {
        let normalized = self.0.normalized();
        let text = normalized.to_string();
        if let Some((mantissa, exponent)) = text.split_once(['e', 'E']) {
            let exponent: i32 = exponent.parse().unwrap_or(0);
            return expand_exponent(mantissa, exponent);
        }
        text
    }
}

fn expand_exponent(mantissa: &str, exponent: i32) -> String {
    let (sign, body) = match mantissa.strip_prefix('-') {
        Some(body) => ("-", body),
        None => ("", mantissa),
    };
    let (int_part, frac_part) = match body.split_once('.') {
        Some((int_part, frac_part)) => (int_part, frac_part),
        None => (body, ""),
    };
    let digits: String = format!("{int_part}{frac_part}");
    let point = int_part.len() as i32 + exponent;
    let out = if point <= 0 {
        format!("0.{}{}", "0".repeat((-point) as usize), digits)
    } else if point as usize >= digits.len() {
        format!("{}{}", digits, "0".repeat(point as usize - digits.len()))
    } else {
        format!("{}.{}", &digits[..point as usize], &digits[point as usize..])
    };
    let trimmed = trim_trailing_zeros(&out);
    format!("{sign}{trimmed}")
}

fn trim_trailing_zeros(value: &str) -> String {
    if !value.contains('.') {
        return value.to_string();
    }
    let trimmed = value.trim_end_matches('0').trim_end_matches('.');
    if trimmed.is_empty() || trimmed == "-" {
        "0".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::Decimal;

    fn d(raw: &str) -> Decimal {
        Decimal::parse(raw).expect("valid decimal")
    }

    #[test]
    fn division_keeps_forty_significant_digits() {
        let value = d("3").div(&d("0.001689")).expect("division");
        assert_eq!(value.to_plain_string(), "1776.198934280639431616341030195381882771");
    }

    #[test]
    fn add_is_exact_for_venue_sized_values() {
        let sum = d("0.001689")
            .mul(&d("1000"))
            .add(&d("0.001690").mul(&d("2500")));
        assert_eq!(sum.to_plain_string(), "5.914");
    }

    #[test]
    fn plain_string_expands_exponents() {
        assert_eq!(d("1e-7").to_plain_string(), "0.0000001");
        assert_eq!(d("123456789012345678901").to_plain_string(), "123456789012345678901");
    }
}


