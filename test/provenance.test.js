'use strict';

const http = require('http');
const assert = require('assert');
const { Provenance } = require('../electron/provenance');

// Mock dockerPorts() so the test is isolated from the real environment.
// The real PPLX container may be running and would otherwise win detection.
Provenance.dockerPorts = async () => [];

async function main() {
  // An OpenAI-compatible /v1/models endpoint with no /metrics:
  // answers, but is not a vLLM server (kind stays 'unknown', state 'external').
  const unknown = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        data: [
          { id: 'qwen2.5-coder:32b' },
          { id: 'deepseek-r1:32b' },
        ],
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
  });

  const vllm = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'qwen38-27b-dflash2' }] }));
      return;
    }
    if (req.url === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end([
        '# HELP vllm:num_requests_running Number of requests currently running.',
        '# TYPE vllm:num_requests_running gauge',
        'vllm:num_requests_running 1',
        'vllm:kv_cache_usage_perc 0.1',
      ].join('\n'));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
  });

  await new Promise((resolve) => unknown.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => vllm.listen(0, '127.0.0.1', resolve));

  const unknownUrl = `http://127.0.0.1:${unknown.address().port}`;
  const vllmUrl = `http://127.0.0.1:${vllm.address().port}`;

  try {
    const unknownProv = new Provenance({
      endpoint: unknownUrl,
      containerName: 'no-such-container',
      intervalMs: 100000,
    });
    const unknownProbe = await unknownProv.start();
    assert.strictEqual(unknownProbe.state, 'external');
    assert.strictEqual(unknownProbe.kind, 'unknown');
    assert.strictEqual(unknownProbe.model, 'qwen2.5-coder:32b');
    assert.deepStrictEqual(unknownProbe.models, ['qwen2.5-coder:32b', 'deepseek-r1:32b']);
    assert.strictEqual(unknownProbe.metricsOk, false);
    // dockerAvailable depends on the test environment; assert it's a boolean.
    assert.strictEqual(typeof unknownProbe.dockerAvailable, 'boolean');
    console.log('PASS: models-only endpoint -> external/unknown');
    unknownProv.stop();

    const vllmProv = new Provenance({
      endpoint: vllmUrl,
      containerName: 'no-such-container',
      intervalMs: 100000,
    });
    const vllmProbe = await vllmProv.start();
    assert.strictEqual(vllmProbe.state, 'external');
    assert.strictEqual(vllmProbe.kind, 'vllm');
    assert.strictEqual(vllmProbe.model, 'qwen38-27b-dflash2');
    assert.strictEqual(vllmProbe.metricsOk, true);
    console.log('PASS: vLLM-shaped endpoint -> external/vllm');
    vllmProv.stop();

    // detect() with the non-vLLM port listed first: the vLLM endpoint still wins.
    // Use a non-existent saved endpoint (port 1) so the saved endpoint doesn't
    // win the detection (the real PPLX service may be running on a random port).
    const detectProv = new Provenance({ endpoint: 'http://127.0.0.1:1', intervalMs: 100000 });
    const detect = await detectProv.detect([unknown.address().port, vllm.address().port]);
    assert.strictEqual(detect.ok, true);
    assert.strictEqual(detect.endpoint, vllmUrl);
    assert.strictEqual(detect.detected.kind, 'vllm');
    assert.strictEqual(detect.detected.detectedKind, 'vllm');
    console.log('PASS: detect prefers vLLM over models-only endpoint');
    detectProv.stop();
  } finally {
    unknown.close();
    vllm.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
