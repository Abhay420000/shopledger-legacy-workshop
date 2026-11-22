var assert = require('node:assert/strict');
var test = require('node:test');
var invoice = require('../lib/invoice');
var orders = require('../lib/orders');
var pricing = require('../lib/pricing');
var reports = require('../lib/reports');

function recordOrder(db, items, coupon, status) {
  var billed = pricing.computeTotals(items, coupon);
  return orders.add(db, {
    date: '15/11/2026',
    items: items,
    coupon: coupon,
    status: status,
    subtotal: billed.subtotal,
    discount: billed.discount,
    tax: billed.tax,
    total: billed.total
  });
}

function gst(rows, taxField) {
  return rows.map(function (row) {
    return [row.gstPercent, row[taxField]];
  });
}

test('a full-rate sale without a coupon agrees with the printable invoice', function () {
  var db = { orders: [], nextOrderId: 1 };
  var order = recordOrder(db, [{ name: 'Tea', hsn: '0902', price: 100, qty: 2 }]);
  var figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.total, 236);
  assert.equal(figures.total, 236);
  assert.equal(figures.tax, 36);
  assert.deepEqual([figures.cgst, figures.sgst], [18, 18]);
  assert.deepEqual(gst(figures.rows, 'lineTax'), [[18, 36]]);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('printable invoice shows the billed GST and total for a capped percentage coupon', function () {
  var db = { orders: [], nextOrderId: 1 };
  var items = [
    { name: 'Rice', hsn: '1006', price: 600, qty: 2 },
    { name: 'Ghee', hsn: '0405', price: 800, qty: 1 }
  ];
  var order = recordOrder(db, items, 'SAVE10');

  var html = invoice.render(order);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td[^>]*>[^<]*144\.30<\/td>/);
  assert.match(html, /Invoice Total<\/td><td[^>]*>[^<]*1994\.30<\/td>/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('a flat coupon reduces taxable value on both checkout and invoice', function () {
  var db = { orders: [], nextOrderId: 1 };
  var order = recordOrder(db, [{ name: 'Tea', hsn: '0902', price: 300, qty: 1 }], 'FLAT50');
  var figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual([order.discount, order.tax, order.total], [50, 45, 295]);
  assert.deepEqual([figures.discount, figures.tax, figures.total], [50, 45, 295]);
});

test('invoice uses checkout GST rates for percentage, fractional and zero overrides', function () {
  var items = [
    { price: 100, qty: 1, gstRate: 5 },
    { price: 100, qty: 1, gstRate: 0.05 },
    { price: 100, qty: 1, gstRate: 0 }
  ];
  var billed = pricing.computeTotals(items);
  var figures = invoice.computeInvoiceFigures({ items: items });

  assert.deepEqual(gst(billed.lines, 'tax'), [[5, 5], [5, 5], [0, 0]]);
  assert.deepEqual(gst(figures.rows, 'lineTax'), [[5, 5], [5, 5], [0, 0]]);
  assert.equal(billed.total, 310);
  assert.equal(figures.total, 310);
});

test('invoice GST sums the rounded line amounts as checkout does', function () {
  var items = [{ price: 0.03, qty: 1 }, { price: 0.03, qty: 1 }];
  var billed = pricing.computeTotals(items);
  var figures = invoice.computeInvoiceFigures({ items: items });

  assert.deepEqual(gst(billed.lines, 'tax'), [[18, 0.01], [18, 0.01]]);
  assert.equal(billed.tax, 0.02);
  assert.equal(billed.total, 0.08);

  assert.deepEqual(gst(figures.rows, 'lineTax'), [[18, 0.01], [18, 0.01]]);
  assert.equal(figures.tax, 0.02);
  assert.deepEqual([figures.cgst, figures.sgst], [0.01, 0.01]);
  assert.equal(figures.total, 0.08);
});

test('CURRENT BEHAVIOUR: reconciliation flags a GST-only mismatch while the invoice shows no warning', function () {
  var db = { orders: [], nextOrderId: 1 };
  var items = [{ name: 'Rice', hsn: '1006', price: 100, qty: 1, gstRate: 5 }];
  var order = recordOrder(db, items);
  // A stored order whose total agrees with the printout but whose tax does not.
  order.tax = 18;
  recordOrder(db, items, '', 'cancelled');

  var report = reports.getGstReconciliation(db);

  assert.equal(report.totalChecked, 1);
  assert.equal(report.mismatchCount, 1);
  assert.equal(report.totalDelta, 0);
  assert.deepEqual(report.rows, [{
    orderId: 1,
    date: '15/11/2026',
    customer: 'Walk-in',
    coupon: '',
    ledgerSubtotal: 100,
    ledgerDiscount: 0,
    ledgerTax: 18,
    ledgerTotal: 105,
    invoiceDiscount: 0,
    invoiceTax: 5,
    invoiceTotal: 105,
    delta: 0,
    matched: false
  }]);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('discounted mixed-GST invoice matches the amount billed and GST breakdown', function () {
  var db = { orders: [], nextOrderId: 1 };
  var order = recordOrder(db, [
    { name: 'Rice', hsn: '1006', price: 600, qty: 2 },
    { name: 'Ghee', hsn: '0405', price: 800, qty: 1 }
  ], 'SAVE10');
  var figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual(
    { total: figures.total, tax: figures.tax, discount: figures.discount },
    { total: 1994.3, tax: 144.3, discount: 150 }
  );
  assert.deepEqual(gst(figures.rows, 'lineTax'), [[5, 55.5], [12, 88.8]]);
  assert.deepEqual([figures.cgst, figures.sgst], [72.15, 72.15]);
});

test('invoice warns when the stored total differs by one cent', function () {
  var db = { orders: [], nextOrderId: 1 };
  var order = recordOrder(db, [{ name: 'Tea', hsn: '0902', price: 100, qty: 2 }]);
  order.total = 235.99;

  assert.match(invoice.render(order), /Accountant Reconciliation Notice:<\/strong>[^<]*236\.00[^<]*235\.99[^<]*\+[^\d<]*0\.01\./);
});

test('a reprinted invoice keeps the billed discount after a coupon is deactivated', function () {
  var db = { orders: [], nextOrderId: 1 };
  var coupon = require('../config').coupons.FLAT50;
  var order = recordOrder(db, [{ name: 'Tea', hsn: '0902', price: 300, qty: 1 }], 'FLAT50');
  var wasActive = coupon.active;

  try {
    coupon.active = false;
    var html = invoice.render(order);
    assert.match(html, /Coupon Discount \(FLAT50\)<\/td><td[^>]*>[^<]*50\.00<\/td>/);
    assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td[^>]*>[^<]*45\.00<\/td>/);
    assert.match(html, /Invoice Total<\/td><td[^>]*>[^<]*295\.00<\/td>/);
    assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
  } finally {
    coupon.active = wasActive;
  }
});

test('reconciliation independently detects an unsupported discount and matching ledger figures', function () {
  var db = { orders: [], nextOrderId: 1 };
  var order = recordOrder(db, [{ name: 'Tea', hsn: '0902', price: 100, qty: 1 }]);
  order.discount = 10;
  order.tax = 16.2;
  order.total = 106.2;

  var report = reports.getGstReconciliation(db);
  assert.equal(report.mismatchCount, 1);
  assert.equal(report.rows[0].invoiceDiscount, 0);
  assert.equal(report.rows[0].invoiceTax, 18);
  assert.equal(report.rows[0].invoiceTotal, 118);
});
