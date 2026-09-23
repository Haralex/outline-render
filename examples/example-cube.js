cube('Customers', {
  sql_table: 'customers',
  data_source: 'custdb',

  measures: {
    count: {
      type: 'count',
    },
    active_count: {
      type: 'count',
      filters: [{ sql: `${CUBE}.status = 'active'` }],
    },
  },

  dimensions: {
    id: {
      sql: '_id',
      type: 'string',
      primary_key: true,
    },
    domain: {
      sql: 'domain',
      type: 'string',
    },
    display_name: {
      sql: 'displayName',
      type: 'string',
    },
    industry: {
      sql: 'industry',
      type: 'string',
    },
    status: {
      sql: 'status',
      type: 'string',
    },
    created_at: {
      sql: 'createdAt',
      type: 'time',
    }
  },
});
