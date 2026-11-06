/* Reading and quiz for each Exercises lesson (js/exercises.js): a short text on the concept, then
 * multiple-choice questions, before the keyboard part. quiz: { q, options, answer (index), why }. */
(function (root) {
  'use strict';
  root.LessonText = {
    'k-c': {
      read: [
        'Music uses only twelve different notes. A piano keyboard repeats the same pattern of twelve keys, seven white and five black, over and over from low (left) to high (right).',
        'The black keys are grouped in twos and threes. That pattern is your map: without it, every white key would look the same. The note C is always the white key directly to the left of a group of two black keys.',
        'Because the pattern repeats, there are many Cs. To tell them apart, each note gets an octave number. Middle C, near the centre of a piano, is C4; the C above it is C5 and the one below is C3.',
      ],
      quiz: [
        { q: 'How many different notes repeat across the keyboard?', options: ['7', '10', '12', '88'], answer: 2, why: 'Twelve: seven white keys and five black keys, repeating in every octave. (88 is the number of keys on a full piano.)' },
        { q: 'Where is C on the keyboard?', options: ['Left of a group of three black keys', 'Left of a group of two black keys', 'Between two black keys', 'It is always a black key'], answer: 1, why: 'C is the white key just left of every pair of black keys.' },
        { q: 'What is middle C called?', options: ['C1', 'C3', 'C4', 'C8'], answer: 2, why: 'Middle C is C4. The number counts octaves from the bottom of the piano.' },
      ],
    },
    'k-white': {
      read: [
        'The white keys use the first seven letters of the alphabet: A B C D E F G. After G the letters start again at A, one octave higher.',
        'Most lessons start from C, so it helps to know the order from there: C D E F G A B, then C again. Going right (up) moves forward through the letters; going left (down) moves backwards.',
        'Another landmark: F is the white key just left of the group of three black keys, so the three black keys sit between F, G, A and B.',
      ],
      quiz: [
        { q: 'Which letters name the white keys?', options: ['A to G', 'A to H', 'C to J', 'Do Re Mi only'], answer: 0, why: 'A to G, seven letters, then the pattern repeats. (Do Re Mi are singing names for the same notes.)' },
        { q: 'What comes after G going up?', options: ['H', 'A', 'C', 'F'], answer: 1, why: 'After G the letters start again: G, A, B, C …' },
        { q: 'Which white key is just left of the group of three black keys?', options: ['C', 'E', 'F', 'B'], answer: 2, why: 'F. C is left of the two black keys, F is left of the three.' },
      ],
    },
    'k-black': {
      read: [
        'The black keys are named after the white keys next to them. A sharp (♯) raises a note by the smallest step, to the very next key on the right. A flat (♭) lowers it to the very next key on the left.',
        'So the black key between C and D can be called C♯ ("C sharp") or D♭ ("D flat"). They are the same key with two names; the name chosen depends on the key of the music.',
        'Sharps and flats are not only black keys: E♯ is the same key as F, and C♭ the same as B, because there is no black key between E and F or between B and C.',
      ],
      quiz: [
        { q: 'What does a sharp (♯) do to a note?', options: ['Lowers it by a half step', 'Raises it by a half step', 'Makes it louder', 'Moves it an octave up'], answer: 1, why: 'A sharp raises a note to the very next key on the right: one half step.' },
        { q: 'The black key between D and E is…', options: ['D♯ or E♭', 'D♭ or E♯', 'Only D♯', 'C♯'], answer: 0, why: 'It is a half step above D (D♯) and a half step below E (E♭).' },
        { q: 'Is there a black key between E and F?', options: ['Yes', 'No'], answer: 1, why: 'No. E–F and B–C are the two places with no black key in between.' },
      ],
    },
    'k-oct': {
      read: [
        'An octave is the distance from one note to the next note with the same name: C4 to C5, or A3 to A4. It is twelve keys, counting black and white, or eight white keys (that is where "oct" comes from).',
        'Two notes an octave apart sound like the same note at a different height. Physically, the higher note vibrates exactly twice as fast: A4 is 440 times a second, A5 880.',
        'That is why men and women singing "the same" melody are often an octave apart, and why the keyboard pattern repeats every octave.',
      ],
      quiz: [
        { q: 'How many half steps (keys, black and white) are in an octave?', options: ['7', '8', '12', '13'], answer: 2, why: 'Twelve half steps. Counting only white keys from C to C gives eight notes, hence "octave".' },
        { q: 'A4 vibrates 440 times a second. How fast does A5 vibrate?', options: ['220', '440', '660', '880'], answer: 3, why: 'An octave up doubles the frequency: 880.' },
        { q: 'C4 to C5 is…', options: ['A half step', 'A fifth', 'An octave', 'Two octaves'], answer: 2, why: 'Same letter, next number up: one octave.' },
      ],
    },
    's-half': {
      read: [
        'The smallest distance between two notes in Western music is a half step (also called a semitone): from any key to the very next key, black or white.',
        'Most neighbouring white keys have a black key between them, so they are two half steps apart. The exceptions are E–F and B–C: those white keys touch, so they are only a half step apart.',
        'Half steps create tension. A melody that moves by a half step into a note, like B to C, sounds as if it is pulling towards that note.',
      ],
      quiz: [
        { q: 'A half step is…', options: ['The next key, black or white', 'The next white key', 'Two keys over', 'Half an octave'], answer: 0, why: 'The very next key in either direction, whatever its colour.' },
        { q: 'Which pair of white keys is a half step apart?', options: ['C–D', 'E–F', 'G–A', 'A–B'], answer: 1, why: 'E–F (and B–C) have no black key between them.' },
        { q: 'A half step above B is…', options: ['B♯ only', 'C', 'C♯', 'A♯'], answer: 1, why: 'B to C is a half step (C can also be called B♯).' },
      ],
    },
    's-whole': {
      read: [
        'A whole step (a tone) is two half steps: skip one key and land on the next. C to D is a whole step, with C♯ skipped in between.',
        'Watch out at E–F and B–C. Because those keys are only a half step apart, a whole step up from E is F♯, and a whole step up from B is C♯.',
        'Whole and half steps are the building blocks of scales. Every scale is a pattern of them; the major scale is whole, whole, half, whole, whole, whole, half.',
      ],
      quiz: [
        { q: 'How many half steps make a whole step?', options: ['1', '2', '3', '4'], answer: 1, why: 'Two half steps.' },
        { q: 'A whole step up from E is…', options: ['F', 'F♯', 'G', 'E♯'], answer: 1, why: 'E–F is only a half step, so you need one more: F♯.' },
        { q: 'Which is the major scale\'s step pattern?', options: ['W W H W W W H', 'W H W W H W W', 'H W W W H W W', 'W W W W W W'], answer: 0, why: 'Whole, whole, half, whole, whole, whole, half. (W H W W H W W is natural minor.)' },
      ],
    },
    's-int': {
      read: [
        'An interval is the distance between two notes. Musicians name intervals by counting letter names, including both ends: C to E covers C, D, E, so it is a 3rd. C to G covers five letters: a 5th.',
        'The quality says the exact size. A major 3rd is 4 half steps (C–E); a minor 3rd is 3 (C–E♭). A perfect 4th is 5 half steps (C–F) and a perfect 5th is 7 (C–G). An octave is 12.',
        'Intervals have their own sounds: major 3rds sound bright, minor 3rds darker, perfect 5ths open and strong (that is the "power chord" in rock). Chords are built by stacking 3rds.',
      ],
      quiz: [
        { q: 'C to G is a…', options: ['3rd', '4th', '5th', '6th'], answer: 2, why: 'C D E F G: five letters, a 5th. It is 7 half steps, a perfect 5th.' },
        { q: 'How many half steps is a major 3rd?', options: ['3', '4', '5', '7'], answer: 1, why: 'Four. A minor 3rd is three.' },
        { q: 'C to E♭ is a…', options: ['Major 3rd', 'Minor 3rd', 'Perfect 4th', 'Major 2nd'], answer: 1, why: 'Three letters (C, D, E♭) and 3 half steps: a minor 3rd.' },
      ],
    },
    's-ear': {
      read: [
        'Reading theory and hearing it go together. Ear training means recognising what you hear: is the second note higher or lower, close or far, and exactly which note is it?',
        'A good method: sing or hum the note you hear, then find it on the keyboard by trying keys near where you think it is. Each miss tells you to go higher or lower.',
        'Many musicians remember intervals by the start of a song: a perfect 4th sounds like "Here Comes the Bride", a perfect 5th like the start of the Star Wars theme, an octave like "Somewhere Over the Rainbow".',
      ],
      quiz: [
        { q: 'You hear a second note and it sounds lower than you guessed. Where should you look next?', options: ['Further right', 'Further left', 'On the black keys only', 'An octave up'], answer: 1, why: 'Lower notes are to the left.' },
        { q: 'Which interval opens the Star Wars main theme?', options: ['Half step', 'Major 3rd', 'Perfect 5th', 'Octave'], answer: 2, why: 'The jump up at the start is a perfect 5th.' },
        { q: 'What helps most when finding a note you heard?', options: ['Guessing a random key', 'Singing it, then searching nearby keys', 'Only playing black keys', 'Turning the volume up'], answer: 1, why: 'Singing holds the note in your memory while you search.' },
      ],
    },
    'sc-c': {
      read: [
        'A scale is a set of notes played in order, from a starting note (the root, or tonic) up to the same note an octave higher. The root is "home": melodies tend to end there.',
        'The major scale is the most important scale in Western music. Its pattern of steps is whole, whole, half, whole, whole, whole, half. Starting on C, that pattern uses only white keys: C D E F G A B C.',
        'The half steps fall between the 3rd and 4th notes (E–F) and between the 7th and 8th (B–C). That last half step is why B pulls so strongly up to C.',
      ],
      quiz: [
        { q: 'What is the first note of a scale called?', options: ['The root (tonic)', 'The fifth', 'The bass', 'The octave'], answer: 0, why: 'The root or tonic: the note the scale is named after and feels like home.' },
        { q: 'Which notes are in C major?', options: ['C D E F G A B', 'C D E♭ F G A♭ B♭', 'C D E F♯ G A B', 'C E G'], answer: 0, why: 'Only the white keys.' },
        { q: 'Where are the half steps in a major scale?', options: ['1–2 and 5–6', '3–4 and 7–8', '2–3 and 6–7', 'There are none'], answer: 1, why: 'Between notes 3–4 (E–F in C) and 7–8 (B–C).' },
      ],
    },
    'sc-major': {
      read: [
        'Any note can be the root of a major scale. Use the same pattern, W W H W W W H, from the new root, and some black keys will be needed to keep the steps right.',
        'G major needs one sharp, F♯ (G A B C D E F♯ G). F major needs one flat, B♭ (F G A B♭ C D E F). D major needs two sharps, F♯ and C♯.',
        'The sharps or flats a key always uses are its key signature, written at the start of each line of sheet music. Each letter appears once in a major scale, so you never get both F and F♯.',
      ],
      quiz: [
        { q: 'Which note does G major use instead of F?', options: ['F♯', 'F♭', 'E♯', 'G♯'], answer: 0, why: 'G major: G A B C D E F♯ G. The F is raised to keep the half step before the root.' },
        { q: 'How many flats does F major have?', options: ['None', 'One (B♭)', 'Two (B♭, E♭)', 'Three'], answer: 1, why: 'One: B♭.' },
        { q: 'What is a key signature?', options: ['The tempo of a song', 'The sharps or flats a key always uses', 'The first chord', 'The composer\'s name'], answer: 1, why: 'It is written at the start of each line so every F (for example) is played as F♯.' },
      ],
    },
    'sc-minor': {
      read: [
        'The natural minor scale has the pattern whole, half, whole, whole, half, whole, whole. The half step comes after the 2nd note, so the 3rd is lower than in major: that lowered 3rd gives minor its darker sound.',
        'A minor uses exactly the same notes as C major (all white keys), only starting on A. Keys that share notes like this are relative major and minor. Every major key has a relative minor starting on its 6th note.',
        'Compared with major on the same root, natural minor lowers the 3rd, 6th and 7th: C minor is C D E♭ F G A♭ B♭.',
      ],
      quiz: [
        { q: 'What is the relative minor of C major?', options: ['C minor', 'A minor', 'E minor', 'G minor'], answer: 1, why: 'A minor: same notes, starting on C major\'s 6th note.' },
        { q: 'Natural minor\'s step pattern is…', options: ['W W H W W W H', 'W H W W H W W', 'H W W H W W W', 'W W W H W W H'], answer: 1, why: 'W H W W H W W.' },
        { q: 'Which note mostly makes a scale sound minor?', options: ['The 2nd', 'A lowered 3rd', 'The 5th', 'The root'], answer: 1, why: 'The minor 3rd (3 half steps above the root).' },
      ],
    },
    'sc-pent': {
      read: [
        '"Penta" means five: pentatonic scales have five notes per octave instead of seven. They leave out the notes that form half steps, so there are no clashes; almost any order of notes sounds good.',
        'The major pentatonic is a major scale without its 4th and 7th: C D E G A. The minor pentatonic is a natural minor scale without its 2nd and 6th: A C D E G.',
        'They are used all over the world, from folk songs to rock and blues solos. The black keys alone form a pentatonic scale, which is why playing only black keys always sounds pleasant.',
      ],
      quiz: [
        { q: 'How many notes does a pentatonic scale have per octave?', options: ['4', '5', '6', '7'], answer: 1, why: 'Five.' },
        { q: 'Which notes does the major pentatonic leave out of the major scale?', options: ['2nd and 6th', '3rd and 7th', '4th and 7th', '1st and 5th'], answer: 2, why: 'The 4th and 7th, the notes that make the half steps.' },
        { q: 'Why do pentatonic scales rarely sound "wrong"?', options: ['They are always quiet', 'They have no half steps', 'They only use white keys', 'They are in minor'], answer: 1, why: 'Without half steps there are no clashing neighbours.' },
      ],
    },
    'c-maj': {
      read: [
        'A chord is three or more notes played together. The basic chord is the triad: a root, the note a 3rd above it, and the note a 5th above it, like stacking every other white key: C, E, G.',
        'A major triad has a major 3rd (4 half steps) from the root to the middle note, then a minor 3rd (3 half steps) to the top: root, +4, +7. C major is C E G, G major is G B D, D major is D F♯ A.',
        'Chords are named after their root. A plain letter, like "G", always means the major chord.',
      ],
      quiz: [
        { q: 'A triad has how many different notes?', options: ['2', '3', '4', '5'], answer: 1, why: 'Three: root, 3rd and 5th.' },
        { q: 'Which notes make D major?', options: ['D F A', 'D F♯ A', 'D E F♯', 'D G A'], answer: 1, why: 'D, a major 3rd up (F♯), a perfect 5th up (A).' },
        { q: 'A chord written just "F" is…', options: ['F major', 'F minor', 'F seventh', 'Only the note F'], answer: 0, why: 'A letter on its own means the major chord.' },
      ],
    },
    'c-min': {
      read: [
        'A minor triad keeps the root and 5th but lowers the 3rd by a half step: root, +3, +7. C minor is C E♭ G; A minor is A C E.',
        'That one note changes the whole mood. Major chords tend to sound bright and settled, minor chords sad or serious. Try A major (A C♯ E) and A minor (A C E) one after the other.',
        'Minor chords are written with a small "m": Am, Em, Dm. Two other triads exist: diminished (both 3rds minor, °, tense) and augmented (both major, +, unsettled).',
      ],
      quiz: [
        { q: 'What is the difference between C major and C minor?', options: ['The root', 'The 3rd is a half step lower in minor', 'The 5th is higher in minor', 'Minor has four notes'], answer: 1, why: 'C E G vs C E♭ G: only the 3rd moves.' },
        { q: 'Which notes make E minor (Em)?', options: ['E G B', 'E G♯ B', 'E A B', 'E G C'], answer: 0, why: 'E, a minor 3rd up (G), a perfect 5th up (B).' },
        { q: 'How is a minor chord usually written?', options: ['With a small m: Am', 'With a +: A+', 'With 7: A7', 'With a capital M: AM'], answer: 0, why: 'Am means A minor.' },
      ],
    },
    'c-key': {
      read: [
        'Build a triad on each note of a scale, using only the scale\'s notes, and you get the chords that belong to that key. In C major: C, Dm, Em, F, G, Am and B° (diminished).',
        'Musicians number these chords with Roman numerals by the scale note they start on: I, ii, iii, IV, V, vi, vii°. Capitals are major, lower case minor.',
        'The numbers work in every key: in G major, I is G, IV is C and V is D. I, IV and V are the main chords; with them you can play a huge number of songs.',
      ],
      quiz: [
        { q: 'In any major key, which chords are major?', options: ['I, IV and V', 'ii, iii and vi', 'I, ii and iii', 'All of them'], answer: 0, why: 'I, IV and V are major; ii, iii and vi minor; vii° diminished.' },
        { q: 'What is the V chord in C major?', options: ['F', 'G', 'Am', 'E'], answer: 1, why: 'G is the 5th note of C major, and its chord is G major.' },
        { q: 'What does a lower-case numeral like "vi" mean?', options: ['A quiet chord', 'A minor chord', 'A seventh chord', 'A chord without a root'], answer: 1, why: 'Lower case means minor.' },
      ],
    },
    'c-ear': {
      read: [
        'Telling major from minor by ear is one of the most useful listening skills. Listen to the overall feeling first: bright and happy usually means major, dark or sad usually means minor.',
        'Then listen to the middle note. In major it sits 4 half steps above the root; in minor 3. If you know the root, try both 3rds and see which matches what you heard.',
        'Your ear improves quickly with practice. Most people start by hearing the mood and only later hear the individual notes, and both are fine.',
      ],
      quiz: [
        { q: 'Which usually sounds brighter?', options: ['Major', 'Minor', 'They sound the same'], answer: 0, why: 'Major chords usually sound brighter.' },
        { q: 'The root is C and the chord sounds minor. Which 3rd does it have?', options: ['E', 'E♭', 'F', 'D'], answer: 1, why: 'C minor is C E♭ G.' },
        { q: 'A major and A minor share which notes?', options: ['A and E', 'A and C', 'C and E', 'None'], answer: 0, why: 'Root and 5th are the same: only the 3rd (C♯ or C) differs.' },
      ],
    },
    'a-7th': {
      read: [
        'Add another 3rd on top of a triad and you get a seventh chord: four notes, root, 3rd, 5th and 7th. The 7th adds colour and tension.',
        'Three kinds are everywhere. Major 7th (Cmaj7: C E G B) sounds soft and dreamy. Dominant 7th (C7: C E G B♭) sounds bluesy and wants to move on. Minor 7th (Cm7: C E♭ G B♭) sounds smooth and mellow.',
        'The dominant 7th is named after the V chord ("dominant"): in C major, G7 (G B D F) pulls strongly back to C. Jazz uses seventh chords almost all the time.',
      ],
      quiz: [
        { q: 'How many notes does a seventh chord have?', options: ['3', '4', '5', '7'], answer: 1, why: 'Four: root, 3rd, 5th and 7th.' },
        { q: 'What is the difference between Cmaj7 and C7?', options: ['The 3rd', 'The 7th: B vs B♭', 'The 5th', 'The root'], answer: 1, why: 'Cmaj7 has B (a major 7th), C7 has B♭ (a minor 7th).' },
        { q: 'Which chord most strongly leads back to C in C major?', options: ['Cmaj7', 'G7', 'Am7', 'Fmaj7'], answer: 1, why: 'G7, the dominant 7th on V.' },
      ],
    },
    'a-inv': {
      read: [
        'The notes of a chord can be played in any order. When the root is the lowest note the chord is in root position. Put another chord note at the bottom and it is an inversion.',
        'First inversion has the 3rd in the bass: C/E (E G C). Second inversion has the 5th in the bass: C/G (G C E). The slash means "chord / bass note".',
        'Inversions keep the chord\'s sound but change its weight, and they let the hand move less between chords: C to F/C or G/B needs only small finger moves.',
      ],
      quiz: [
        { q: 'What does C/E mean?', options: ['C or E', 'A C chord with E as the lowest note', 'C minus E', 'C and E only'], answer: 1, why: 'Chord / bass note: C major with E at the bottom.' },
        { q: 'A chord with its 5th in the bass is in…', options: ['Root position', 'First inversion', 'Second inversion', 'Third inversion'], answer: 2, why: '5th in the bass is second inversion.' },
        { q: 'Does an inversion change which notes are in the chord?', options: ['Yes', 'No, only their order'], answer: 1, why: 'Same notes, different order.' },
      ],
    },
    'a-modes': {
      read: [
        'Play the white keys from D to D and you get a different scale from C major, even though the notes are the same. Each starting note gives a mode with its own pattern and mood.',
        'The seven modes of the major scale: Ionian (C, the major scale), Dorian (D), Phrygian (E), Lydian (F), Mixolydian (G), Aeolian (A, natural minor) and Locrian (B).',
        'Dorian is minor with a raised 6th (funk, jazz). Phrygian is minor with a ♭2 (flamenco, metal). Lydian is major with a ♯4 (film music). Mixolydian is major with a ♭7 (rock and blues).',
      ],
      quiz: [
        { q: 'Which mode starts on the 2nd note of the major scale (D, using only white keys)?', options: ['Dorian', 'Phrygian', 'Lydian', 'Locrian'], answer: 0, why: 'D to D on the white keys is D Dorian.' },
        { q: 'Mixolydian is like major but with…', options: ['A raised 4th', 'A lowered 7th', 'A lowered 3rd', 'No 5th'], answer: 1, why: 'A ♭7: G Mixolydian has F instead of F♯.' },
        { q: 'Aeolian is another name for…', options: ['The major scale', 'Natural minor', 'Blues scale', 'Pentatonic'], answer: 1, why: 'Aeolian is the natural minor scale.' },
      ],
    },
    'a-prog': {
      read: [
        'A chord progression is the order of chords in a song. Because Roman numerals work in every key, a progression can be written once and played anywhere.',
        'I–V–vi–IV is probably the most used progression in pop music: in C major it is C, G, Am, F. Others to know: I–IV–V (rock and roll, blues), ii–V–I (jazz), vi–IV–I–V (the same chords starting on the minor).',
        'Progressions create a journey away from home (I) and back. The V chord builds tension; returning to I releases it. That move, V to I, is called a cadence.',
      ],
      quiz: [
        { q: 'I–V–vi–IV in C major is…', options: ['C G Am F', 'C F G C', 'Dm G C Am', 'C Em F G'], answer: 0, why: 'I = C, V = G, vi = Am, IV = F.' },
        { q: 'Which progression is typical of jazz?', options: ['I–V–vi–IV', 'ii–V–I', 'I–I–I', 'vi–vi–vi'], answer: 1, why: 'ii–V–I.' },
        { q: 'What is a cadence?', options: ['A fast tempo', 'A chord move that ends a phrase, like V–I', 'A kind of drum', 'A scale'], answer: 1, why: 'A cadence closes a phrase; V to I is the strongest.' },
      ],
    },
  };
})(window);
