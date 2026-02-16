import esbuild from 'esbuild';

const isProduction = process.argv.includes('production');

const context = await esbuild.context({
  entryPoints: ['main.ts'],
  bundle: true,
  outfile: 'main.js',
  platform: 'browser',
  format: 'cjs',
  sourcemap: !isProduction,
  minify: isProduction,
  external: ['obsidian'],
  logLevel: 'info'
});

if (isProduction) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
  console.log('Watching for changes...');
}
