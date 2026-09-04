#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';

const DEFAULTS = {
  apiService: 'code-interpreter',
  redisService: 'Redis',
  bucket: 'LC-Storage',
};

function usage() {
  console.log(`Usage:
  node scripts/railway-compact.mjs --apply [options]

Options:
  --apply                 Set Railway variables
  --dry-run               Print actions only (default)
  --api-service <name>    Code API service name (default: code-interpreter)
  --redis-service <name>  Redis service name (default: Redis)
  --bucket <name>         Railway bucket name (default: LC-Storage)
  --help                  Show this help

This switches the Code API Railway service to a compact single-container
control plane and points file/checkpoint storage at a Railway bucket.`);
}

function parseArgs(argv) {
  const args = { ...DEFAULTS, dryRun: true };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help') {
      usage();
      process.exit(0);
    } else if (arg === '--apply') {
      args.dryRun = false;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--api-service') {
      args.apiService = argv[++i];
    } else if (arg === '--redis-service') {
      args.redisService = argv[++i];
    } else if (arg === '--bucket') {
      args.bucket = argv[++i];
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return args;
}

function capture(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function run(cmd, args, options = {}) {
  const printableArgs = args.map((arg) => {
    if (cmd !== 'railway' || !arg.includes('=')) return arg;
    const key = arg.split('=')[0];
    return `${key}=<set>`;
  });
  if (options.dryRun) {
    console.log(`dry-run: ${[cmd, ...printableArgs].join(' ')}`);
    return;
  }
  execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

function bucketCredentials(bucket) {
  const raw = capture('railway', ['bucket', 'credentials', '--bucket', bucket, '--json']);
  const creds = JSON.parse(raw);
  const endpoint = new URL(creds.endpoint);
  return {
    bucketName: creds.bucketName,
    endpointHost: endpoint.hostname,
    endpointPort: endpoint.port || (endpoint.protocol === 'https:' ? '443' : '80'),
    useSsl: endpoint.protocol === 'https:' ? 'true' : 'false',
    region: creds.region || 'auto',
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const railway = spawnSync('railway', ['--version'], { encoding: 'utf8' });
  if (railway.status !== 0) {
    throw new Error('Railway CLI is not available in PATH');
  }

  const bucket = bucketCredentials(args.bucket);
  const redisVars = {
    REDIS_HOST: `\${{${args.redisService}.REDISHOST}}`,
    REDIS_PORT: `\${{${args.redisService}.REDISPORT}}`,
    REDIS_PASSWORD: `\${{${args.redisService}.REDISPASSWORD}}`,
  };

  const vars = {
    RAILWAY_DOCKERFILE_PATH: 'Dockerfile.railway-control',
    PORT: '3112',
    SERVICE_PORT: '3112',
    FILE_SERVER_PORT: '3000',
    TOOL_CALL_SERVER_PORT: '3033',
    FILE_SERVER_URL: 'http://127.0.0.1:3000',
    TOOL_CALL_SERVER_URL: 'http://127.0.0.1:3033',
    TOOL_CALL_REQUEST_TIMEOUT: '300000',
    TOOL_CALL_SESSION_EXPIRY: '600',
    MINIO_BUCKET: bucket.bucketName,
    CODEAPI_CHECKPOINT_BUCKET: bucket.bucketName,
    MINIO_ENDPOINT: bucket.endpointHost,
    MINIO_PORT: bucket.endpointPort,
    MINIO_USE_SSL: bucket.useSsl,
    MINIO_REGION: bucket.region,
    MINIO_ACCESS_KEY: bucket.accessKeyId,
    MINIO_SECRET_KEY: bucket.secretAccessKey,
    ...redisVars,
  };

  const entries = Object.entries(vars).map(([key, value]) => `${key}=${value}`);
  run('railway', ['variable', 'set', '--service', args.apiService, '--skip-deploys', ...entries], {
    dryRun: args.dryRun,
  });

  console.log(`${args.dryRun ? 'Would set' : 'Set'} compact Code API variables on ${args.apiService}`);
  console.log(`Bucket: ${args.bucket} (${bucket.bucketName} at ${bucket.endpointHost})`);
  console.log('Secrets were not printed.');
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
