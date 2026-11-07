const path = require('path')
const root = path.resolve(__dirname, '../..')
module.exports = {
    mode: 'development', target: 'web', devtool: false, entry: path.join(__dirname, 'harness.ts'),
    output: { path: path.join(root, '.test-ui'), filename: 'harness.js' },
    resolve: { extensions: ['.ts', '.js'], alias: {
        'tabby-core$': path.join(__dirname, 'tabby.mock.ts'),
        'tabby-settings$': path.join(__dirname, 'tabby.mock.ts'),
        [path.join(root, 'src/services/stats.service.ts')]: path.join(__dirname, 'stats.mock.ts'),
        [path.join(root, 'src/tutorial.ts')]: path.join(__dirname, 'tutorial.mock.ts'),
    } },
    module: { rules: [ { test: /\.ts$/, use: { loader: 'ts-loader', options: { transpileOnly: true, compilerOptions: { rootDir: root } } } }, { test: /\.svg$/, type: 'asset/source' } ] },
    performance: { hints: false }, stats: 'errors-warnings'
}
