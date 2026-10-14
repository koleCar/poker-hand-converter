//! Commands: one per line on standard input or in a `--script` file, and
//! what the keyboard sends. Tables are named by the number the simulator
//! gave them (1, 2, ...; never reused).
//!
//! ```text
//! pause | resume | toggle          stop / restart writing hands
//! speed <hands per minute>         per table, e.g. `speed 2.5`
//! faster | slower                  speed x2 / /2
//! open [size]                      a new table
//! close <table>                    close a table (its window too)
//! hand <table>                     the table's next hand now
//! tablemove <table>                the player is moved to another table:
//!                                  new table name and title, new opponents
//! move <table> <x> <y>             window position (screen pixels)
//! resize <table> <width> <height>  window client size (pixels)
//! minimize <table> | restore <table> | focus <table>
//! tile                             windows back to the grid
//! status                           a `status` event with every table
//! quit
//! wait <ms>                        scripts only: pause the script
//! ```
//!
//! `#` starts a comment; blank lines are ignored.

/// A parsed command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Pause,
    Resume,
    TogglePause,
    /// Hands per minute per table, in hundredths.
    Speed(u32),
    Faster,
    Slower,
    Open(Option<u32>),
    Close(u32),
    Hand(u32),
    TableMove(u32),
    Move(u32, i32, i32),
    Resize(u32, u32, u32),
    Minimize(u32),
    Restore(u32),
    Focus(u32),
    Tile,
    Status,
    Quit,
    /// Scripts only.
    Wait(u64),
}

impl Command {
    /// Commands only a window can carry out (ignored without windows).
    pub fn is_window(&self) -> bool {
        matches!(
            self,
            Self::Move(..)
                | Self::Resize(..)
                | Self::Minimize(_)
                | Self::Restore(_)
                | Self::Focus(_)
                | Self::Tile
        )
    }

    /// One line; `Ok(None)` for a blank or comment line.
    pub fn parse(line: &str) -> Result<Option<Self>, String> {
        let line = line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            return Ok(None);
        }
        let words: Vec<&str> = line.split_whitespace().collect();
        let arg = |i: usize| -> Result<&str, String> {
            words
                .get(i)
                .copied()
                .ok_or_else(|| format!("{line:?}: missing argument {i}"))
        };
        let num = |i: usize| -> Result<u32, String> {
            arg(i)?
                .parse::<u32>()
                .map_err(|_| format!("{line:?}: argument {i} is not a number"))
        };
        let int = |i: usize| -> Result<i32, String> {
            arg(i)?
                .parse::<i32>()
                .map_err(|_| format!("{line:?}: argument {i} is not a number"))
        };
        let cmd = match words[0].to_lowercase().as_str() {
            "pause" => Self::Pause,
            "resume" => Self::Resume,
            "toggle" => Self::TogglePause,
            "speed" => Self::Speed(parse_speed(arg(1)?)?),
            "faster" => Self::Faster,
            "slower" => Self::Slower,
            "open" => Self::Open(if words.len() > 1 { Some(num(1)?) } else { None }),
            "close" => Self::Close(num(1)?),
            "hand" => Self::Hand(num(1)?),
            "tablemove" => Self::TableMove(num(1)?),
            "move" => Self::Move(num(1)?, int(2)?, int(3)?),
            "resize" => Self::Resize(num(1)?, num(2)?, num(3)?),
            "minimize" | "minimise" => Self::Minimize(num(1)?),
            "restore" => Self::Restore(num(1)?),
            "focus" => Self::Focus(num(1)?),
            "tile" => Self::Tile,
            "status" => Self::Status,
            "quit" | "exit" => Self::Quit,
            "wait" => Self::Wait(u64::from(num(1)?)),
            other => return Err(format!("unknown command {other:?}")),
        };
        Ok(Some(cmd))
    }
}

/// Hands per minute (`2`, `2.5`, `0.75`) in hundredths; at least 0.01.
pub fn parse_speed(text: &str) -> Result<u32, String> {
    let bad = || format!("{text:?} is not a number of hands per minute");
    let (whole, frac) = text.split_once('.').unwrap_or((text, ""));
    if frac.len() > 2 || (whole.is_empty() && frac.is_empty()) {
        return Err(bad());
    }
    let whole: u32 = if whole.is_empty() {
        0
    } else {
        whole.parse().map_err(|_| bad())?
    };
    let frac: u32 = match frac.len() {
        0 => 0,
        1 => frac.parse::<u32>().map_err(|_| bad())? * 10,
        _ => frac.parse().map_err(|_| bad())?,
    };
    let centi = whole
        .checked_mul(100)
        .and_then(|w| w.checked_add(frac))
        .ok_or_else(bad)?;
    if centi == 0 {
        return Err(format!("{text:?}: the speed must be above zero"));
    }
    Ok(centi)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses() {
        assert_eq!(Command::parse("  # c"), Ok(None));
        assert_eq!(Command::parse("pause"), Ok(Some(Command::Pause)));
        assert_eq!(
            Command::parse("move 2 -10 300 # left"),
            Ok(Some(Command::Move(2, -10, 300)))
        );
        assert_eq!(
            Command::parse("resize 1 640 480"),
            Ok(Some(Command::Resize(1, 640, 480)))
        );
        assert_eq!(Command::parse("open"), Ok(Some(Command::Open(None))));
        assert_eq!(Command::parse("open 9"), Ok(Some(Command::Open(Some(9)))));
        assert_eq!(Command::parse("speed 2.5"), Ok(Some(Command::Speed(250))));
        assert!(Command::parse("move 1").is_err());
        assert!(Command::parse("dance").is_err());
        assert!(Command::Move(1, 0, 0).is_window());
        assert!(!Command::Close(1).is_window());
    }

    #[test]
    fn speeds() {
        assert_eq!(parse_speed("2"), Ok(200));
        assert_eq!(parse_speed("0.75"), Ok(75));
        assert_eq!(parse_speed(".5"), Ok(50));
        assert_eq!(parse_speed("600"), Ok(60_000));
        assert!(parse_speed("0").is_err());
        assert!(parse_speed("1.234").is_err());
        assert!(parse_speed("x").is_err());
    }
}
