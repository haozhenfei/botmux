export default {
  test: {
    include: [
      'test/report-session-relay.test.ts',
      'test/dispatch-report-binding.test.ts',
    ],
    testTimeout: 30_000,
  },
};
