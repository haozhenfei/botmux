import { plugin } from 'bun';

plugin({
  name: 'observe-cli-unused-node-pty-stub',
  setup(build) {
    build.onResolve({ filter: /^node-pty$/ }, () => ({ path: 'node-pty', namespace: 'observe-e2e' }));
    build.onLoad({ filter: /.*/, namespace: 'observe-e2e' }, () => ({
      contents: 'export function spawn() { throw new Error("node-pty is outside the observe command path"); }',
      loader: 'js',
    }));
  },
});
