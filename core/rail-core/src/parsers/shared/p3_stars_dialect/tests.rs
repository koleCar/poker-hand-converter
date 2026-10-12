//! The source check and the two reorderings. The dispatcher itself is held to
//! the TypeScript over the Run It Once and PokerBros samples and edits of them
//! (`tests/psgg_vectors.rs`, `dialect`).

use super::*;
use crate::phf::money::EUR;

const SOURCE: &str =
    include_str!("../../../../../../frontend/src/lib/parsers/shared/p3-stars-dialect.ts");

const LITERALS: &[&str] = &[
    r"/^Table(?: ID)? '(.*)' (\d+)-max(?: \(([^)]*)\))?(?: Seat #(\d+) is the button)?\s*$/i",
    r"/^Seat (\d+): (.+?) \(([^)]+) in chips\)(.*)$/",
    r"/^\*\*\*\s*(FIRST|SECOND|THIRD)?\s*(FLOP|TURN|RIVER|SHOW\s?DOWN)\s*\*\*\*(.*)$/i",
    r"/and is all-in/",
    r#"/\bsaid, "|\bjoins the table\b|\bleaves the table\b|\bis sitting out\b|\bsits out\b|\bhas timed out\b|\bis (?:dis)?connected\b|\bhas returned\b/i"#,
    r"/^Uncalled bet \(.*\) returned to /",
    r"/SHOW\s?DOWN/i",
    r"/^\*\*\*\s*SUMMARY\s*\*\*\*/i",
    r"/^(FIRST |SECOND |THIRD )?Board\s*\[([^\]]*)\]/i",
    r"/^Seat (\d+):/",
    r"/\bis sitting out\b/i",
    r"/\[hero\]/i",
    r"/^\*\*\*\s*HOLE CARDS\s*\*\*\*/i",
    r"/^Dealt to (.+?)(?: \[([^\]]*)\])?\s*$/",
    r"/^(.+?): (folds|checks)$/",
    r"/^(.+?):? shows \[([^\]]*)\](?:\s*(?:for |\()(.+?)\)?)?$/",
    r"/^(.+?): (mucks hand|doesn't show hand)$/i",
    r"/^(.+?)[: ]+(?:is sitting out|sits out)\s*$/i",
];
const TEMPLATES: &[&str] = &[
    r"((?: and is all-in)*)",
    r"^Total pot ${MONEY}\s*$",
    r"^(Main|Side) pot(?:-(\d+))? ${MONEY}$",
    r"^Rake ${MONEY}$",
    r"^STP ${MONEY}$",
    r"^STP added:\s*${MONEY}\s*$",
    r"^Uncalled bet \(${MONEY}\) returned to (.+)$",
    r"^(.+?) collected ${MONEY} from (?:the )?(.+?)$",
    r"^(.+?): posts the ante ${MONEY}${SUFFIX}$",
    r"^(.+?): posts (small|big) blind ${MONEY}${SUFFIX}$",
    r"^(.+?): posts ${MONEY}${SUFFIX}$",
    r"^(.+?): (calls|bets) ${MONEY}${SUFFIX}$",
    r"^(.+?): raises ${MONEY} to ${MONEY}${SUFFIX}$",
];

#[test]
fn patterns_are_the_typescript_source() {
    for pattern in LITERALS {
        assert!(SOURCE.contains(pattern), "{pattern}");
    }
    for template in TEMPLATES {
        assert!(
            SOURCE.contains(&format!("String.raw`{template}`")),
            "{template}"
        );
    }
    assert!(SOURCE.contains(r#"import { MONEY, type StarsHandDraft } from "./p3-draft";"#));
}

#[test]
fn hoists_an_uncalled_return_printed_below_the_showdown_marker() {
    let lines = [
        "header",
        "*** FLOP *** [6h Jd 4c]",
        "a: bets €0.21",
        "*** SHOWDOWN ***",
        "a: mucks hand",
        "Uncalled bet (€0.71) returned to a",
        "a collected €0.71 from pot",
        "*** RIVER *** [x]",
        "Uncalled bet (€1) returned to b",
    ];
    let ordered: Vec<(&str, usize)> = hoist_uncalled_before_showdown(&lines);
    assert_eq!(
        ordered,
        [
            ("header", 1),
            ("*** FLOP *** [6h Jd 4c]", 2),
            ("a: bets €0.21", 3),
            ("Uncalled bet (€0.71) returned to a", 6),
            ("*** SHOWDOWN ***", 4),
            ("a: mucks hand", 5),
            ("a collected €0.71 from pot", 7),
            ("*** RIVER *** [x]", 8),
            ("Uncalled bet (€1) returned to b", 9),
        ]
    );
}

#[test]
fn reads_the_pipe_separated_pot_line() {
    let eur = EUR.unit();
    let pot = parse_pot_line(
        "Total pot €0.75 | Main pot €0.25 | STP €0.50 | Rake €0.04",
        &eur,
    )
    .expect("a pot line");
    assert_eq!((pot.total, pot.house_chips, pot.fees.rake), (75, 50, 4));
    // A lone `Main` column is no side-pot structure.
    assert!(pot.pots.is_empty());
    let side = parse_pot_line("Total pot €10 | Main pot €6 | Side pot-1 €4 | Odd €1", &eur)
        .expect("a pot line");
    assert_eq!(
        side.pots,
        [
            PhfPot {
                name: "Main".to_owned(),
                amount: 600
            },
            PhfPot {
                name: "Side-1".to_owned(),
                amount: 400
            }
        ]
    );
    assert!(parse_pot_line("Total pot €10 Main pot €6.", &eur).is_none());
}
