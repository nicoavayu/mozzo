async function resetOperationalDemoState(database) {
  return database.withTransaction(async () => {
    await database.run('DELETE FROM cash_register_movements');
    await database.run('DELETE FROM order_payment_split_allocations');
    await database.run('DELETE FROM order_bill_splits');
    await database.run('DELETE FROM order_charge_adjustments');
    await database.run('DELETE FROM mercado_pago_checkouts');
    await database.run('DELETE FROM order_payment_reversals');
    await database.run('DELETE FROM order_payments');
    await database.run('DELETE FROM order_suborder_items');
    await database.run('DELETE FROM order_suborders');
    await database.run('DELETE FROM table_requests');
    await database.run('DELETE FROM order_items');
    await database.run('DELETE FROM orders');
    await database.run('DELETE FROM cash_register_sessions');

    await database.run(
      `
        DELETE FROM sqlite_sequence
        WHERE name IN (
          'order_payment_split_allocations',
          'cash_register_movements',
          'order_bill_splits',
          'order_charge_adjustments',
          'mercado_pago_checkouts',
          'order_payment_reversals',
          'order_payments',
          'order_suborder_items',
          'order_suborders',
          'table_requests',
          'order_items',
          'orders',
          'cash_register_sessions'
        )
      `
    );

    return {
      reset_at: new Date().toISOString(),
      cleared: {
        orders: true,
        table_requests: true,
        cash_register_sessions: true,
        cash_register_movements: true,
        payments: true,
        reversals: true,
        suborders: true,
        split_bill: true,
        charge_adjustments: true,
        mercado_pago_checkouts: true,
      },
    };
  });
}

module.exports = {
  resetOperationalDemoState,
};
