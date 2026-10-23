const channel = process.argv[2] ?? 'market_cake_usdt_depth_step0';
const ws = new WebSocket('wss://wswn.spentr.com/trade/multiple');
const timer = setTimeout(() => {
  console.log('timeout');
  ws.close();
  process.exit(0);
}, 12000);
ws.onopen = () => {
  console.log('open', channel);
  ws.send(JSON.stringify({ event: 'addChannel', channel }));
};
ws.onmessage = (event) => {
  console.log('message', String(event.data).slice(0, 2000));
};
ws.onerror = (event) => {
  console.log('error', event.message ?? event.type);
};
