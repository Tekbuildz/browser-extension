module.exports = {
    content: [
        // Note: The following list of file extensions must NOT contain whitespaces, as e.g. {html, ts} will
        // search for '*.html' and '*. ts' - the latter not yielding any results
        "./chrome/background.{ts,js}",
        "./chrome/proxy-help.html",
        "./chrome/background_helpers/**/*.{html,js,ts}",
        "./chrome/checking/**/*.{html,js,ts}",
        "./chrome/options/**/*.{html,js,ts}",
        "./chrome/popup/**/*.{html,js,ts}",
        "./chrome/shared/**/*.{html,js,ts}",
    ],
    theme: {
        extend: {},
    },
    plugins: [require("daisyui")],
    daisyui: {
        themes: ["light"],
    }
}