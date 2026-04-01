module.exports = {
  id: '015_add_bill_payment_flow_fields',
  async up(context) {
    if (!(await context.columnExists('orders', 'bill_payment_method_preference'))) {
      await context.exec(`
        ALTER TABLE orders
        ADD COLUMN bill_payment_method_preference TEXT
        CHECK (bill_payment_method_preference IN ('cash', 'card', 'mercado_pago'))
      `);
    }

    if (!(await context.columnExists('orders', 'bill_collection_status'))) {
      await context.exec(`
        ALTER TABLE orders
        ADD COLUMN bill_collection_status TEXT
        CHECK (bill_collection_status IN (
          'requested',
          'waiting_cash',
          'waiting_card',
          'checkout_pending',
          'partial_payment',
          'payment_recorded'
        ))
      `);
    }
  }
};
