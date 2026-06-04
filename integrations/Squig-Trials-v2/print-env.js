import 'dotenv/config';
console.log('DATABASE_URL:', process.env.DATABASE_URL ? '[SET]' : '[MISSING]');
console.log('DISCORD_TOKEN:', process.env.DISCORD_TOKEN ? '[SET]' : '[MISSING]');
