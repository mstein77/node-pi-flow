export default {
    include: ['**/*.test.ts'],
    coverage: {
        include: ['src/**/*.js', 'src/**/*.jsx', 'src/**/*.ts'],
        exclude: ['node_modules/**/*'],
        reporter: ['html']
    }
}
