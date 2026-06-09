import { spawn } from 'child_process';

console.log('Spawning drizzle-kit generate...');
const child = spawn('npx', ['drizzle-kit', 'generate'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  shell: true
});

child.stdout.on('data', (data) => {
  const text = data.toString();
  process.stdout.write(text);
  if (text.includes('Is payment_method_id column') || text.includes('Is') || text.includes('?') || text.includes('❯')) {
    console.log('\nSending newline (default option)...');
    child.stdin.write('\n');
  }
});

child.on('close', (code) => {
  console.log(`drizzle-kit generate closed with code ${code}`);
  process.exit(code);
});
