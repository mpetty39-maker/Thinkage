# Thinkage

A cooperative word-linking party game for 3 to 6 players. Everyone plays on their own phone. No accounts.

## Run it on your computer

    npm install
    npm start

Open http://localhost:3000 in several browser tabs (or on phones on the same Wi-Fi using your computer's address) to try it. `npm test` plays full simulated games and checks the scoring.

## Put it online with GitHub and Render

1. Create a new GitHub repository and push this folder to it (leave `node_modules` out; `.gitignore` already does).
2. In Render choose **New > Web Service** and connect that repository. (Or choose **New > Blueprint** and Render reads `render.yaml`.)
3. If you set it up by hand use: Runtime **Node**, Build command `npm install`, Start command `npm start`, Instance type **Free**.
4. When the deploy finishes, open the `onrender.com` address on a phone. One player taps **Start a new game** and shares the four-letter code. Everyone else taps **Join game**.

Render's free tier puts the server to sleep after a while without visitors. The first person to open it afterward waits about a minute. Games are kept in memory, so a restart or redeploy ends any game in progress.

## How the game plays

- **Link.** Each player is secretly given one word from a lettered list (A to J for 3 or 4 players, A to K for 5 or 6). They pick a second word and type one clue word that links the two. The group decides what counts as a good link; the app does not check.
- **Think.** When everyone has locked in a link, everyone sees the other players' clues and guesses which two words each player linked. A guess can be starred.
- **One clock.** The round clock covers both phases: 2:00 (3 players), 2:20 (4), 2:40 (5), 3:00 (6). If time runs out during Link there is no Think phase and the round scores 0. If it runs out during Think, guesses already made count and the rest score 0.
- **Scoring.** Right guess +1. Right and starred +2. Wrong and starred -1. Wrong and unstarred 0.
- **Same pair.** If two players link the same two words, each other player scores that pair once (the better of their two guesses counts). The other players then vote on whether the two clues were the same (plurals and typos count as the same; a tie counts as different). If the clues were the same, nobody scores that pair and a star on it costs nothing.
- **Team result.** After round 3 the team score is compared to a perfect game: every player guessing every other player correctly in all 3 rounds, plus 25% for stars. 90% and up Excellent, 80-89% Good, 70-79% OK, 60-69% Satisfactory, 50-59% "Were you really trying?", under 50% "Not good! Better luck next time."
- The host can pause the clock. Players who lose their connection rejoin automatically with the same seat.

## Files

- `server.js` the game server (rooms, phases, scoring, voting)
- `words.js` the two 500-word lists: Classic, and Bible & church history. Add another list by adding a key.
- `public/` the phone screens (`index.html`, `style.css`, `app.js`)
- `test/sim.js` simulated games
