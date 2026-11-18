/**
 * Recording shim for the depth port.
 *
 * rust-anything replays JSON through the module it is pointed at, but
 * `packages/core/src/depth.ts` operates on `Decimal` instances. This module
 * rehydrates the recorded JSON into the real runtime shapes, then delegates to
 * the untouched TypeScript implementation, so the recorded results are the
 * production results.
 */
const path = require('node:path');
const Decimal = require(path.resolve('node_modules/decimal.js'));
const original = require(path.resolve('packages/core/dist/depth.js'));

function toDepthLevel(level) {
  return {
    price: new Decimal(String(level.price)),
    amount: new Decimal(String(level.amount)),
  };
}

function toBook(book) {
  return {
    venueId: book.venueId,
    exchangeSymbol: book.exchangeSymbol,
    fetchedAt: book.fetchedAt,
    receivedAt: book.receivedAt,
    asks: (book.asks || []).map(toDepthLevel),
    bids: (book.bids || []).map(toDepthLevel),
    source: book.source || 'rest',
  };
}

const dec = (value) => new Decimal(String(value));

module.exports = {
  calculateBuyDepthByQuote: (book, requestedQuote) =>
    original.calculateBuyDepthByQuote(toBook(book), dec(requestedQuote)),
  calculateBuyDepthByBase: (book, requestedBase) =>
    original.calculateBuyDepthByBase(toBook(book), dec(requestedBase)),
  calculateSellDepthByBase: (book, requestedBase) =>
    original.calculateSellDepthByBase(toBook(book), dec(requestedBase)),
  calculateSellDepthByQuote: (book, requestedQuote) =>
    original.calculateSellDepthByQuote(toBook(book), dec(requestedQuote)),
  simulateTwoLegBaseAmount: (buyBook, sellBook, requestedQuote) =>
    original.simulateTwoLegBaseAmount(toBook(buyBook), toBook(sellBook), dec(requestedQuote)),
};
