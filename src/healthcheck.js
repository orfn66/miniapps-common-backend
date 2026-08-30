const response = await fetch("http://127.0.0.1:3000/api/health", {
  signal: AbortSignal.timeout(2_000),
});

if (!response.ok) process.exit(1);
