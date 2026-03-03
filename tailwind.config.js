module.exports = {
    content: [
        // Note: The following list of file extensions must NOT contain whitespaces, as e.g. {html, ts} will
        // search for '*.html' and '*. ts' - the latter not yielding any results
        './chrome/**/*.{html,js,ts}',
    ],
    theme: {
        extend: {},
    },
    plugins: [require("daisyui")],
    daisyui: {
        themes: ["light"],
    }
}