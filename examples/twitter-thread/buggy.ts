// Example buggy TypeScript code for demo
function calculateTotal(items: any[]) {
  let total = 0;
  for (let i = 0; i <= items.length; i++) {
    total += items[i].price;
  }
  return total;
}

const cart = [
  { name: "Widget", price: 10 },
  { name: "Gadget", price: 20 }
];

console.log(calculateTotal(cart));
