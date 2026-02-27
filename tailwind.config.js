module.exports = {
    content: [
        './core/**/*.{html, js, ts}',
    ],
    theme: {
        extend: {},
    },
    plugins: [require("daisyui")],
    daisyui: {
        themes: ["light"],
    }
}