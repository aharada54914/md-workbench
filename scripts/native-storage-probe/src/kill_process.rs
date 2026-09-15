//! Bounded child transport. Only the Child returned by our spawn can be terminated.
use serde::{de::DeserializeOwned, Serialize};
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
const MAX_MESSAGE: usize = 4096;
const DEADLINE: Duration = Duration::from_secs(15);
pub fn emit(value: &impl Serialize) -> Result<(), &'static str> {
    let mut bytes = serde_json::to_vec(value).map_err(|_| "encode_message")?;
    if bytes.len() >= MAX_MESSAGE {
        return Err("oversize_message");
    }
    bytes.push(b'\n');
    let mut out = std::io::stdout().lock();
    out.write_all(&bytes)
        .and_then(|_| out.flush())
        .map_err(|_| "write_message")
}
fn read_message(reader: &mut impl BufRead) -> Result<Vec<u8>, &'static str> {
    let mut bytes = Vec::new();
    reader
        .take((MAX_MESSAGE + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .map_err(|_| "read_message")?;
    if bytes.last() != Some(&b'\n') || bytes.len() > MAX_MESSAGE {
        return Err("invalid_message_length");
    }
    Ok(bytes)
}
fn receive<T: DeserializeOwned>(
    messages: &mpsc::Receiver<Result<Vec<u8>, &'static str>>,
    timeout: Duration,
) -> Result<T, &'static str> {
    let bytes = messages
        .recv_timeout(timeout)
        .map_err(|error| match error {
            mpsc::RecvTimeoutError::Timeout => "handshake_timeout",
            mpsc::RecvTimeoutError::Disconnected => "handshake_closed",
        })??;
    serde_json::from_slice(&bytes).map_err(|_| "invalid_message")
}
pub struct OwnedChild {
    child: Child,
    messages: mpsc::Receiver<Result<Vec<u8>, &'static str>>,
}
impl OwnedChild {
    pub fn spawn(args: &[&str]) -> Result<Self, &'static str> {
        let mut child = Command::new(std::env::current_exe().map_err(|_| "executable")?)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "spawn")?;
        let stdout = child.stdout.take().ok_or("missing_stdout")?;
        let (sender, messages) = mpsc::channel();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            // Ready + Done is the only two-message protocol. Reader output is bounded.
            for _ in 0..2 {
                let result = read_message(&mut reader);
                let failed = result.is_err();
                if sender.send(result).is_err() || failed {
                    break;
                }
            }
        });
        Ok(Self { child, messages })
    }
    pub fn receive<T: DeserializeOwned>(&self) -> Result<T, &'static str> {
        receive(&self.messages, DEADLINE)
    }
    pub fn proceed(&mut self) -> Result<(), &'static str> {
        self.child
            .stdin
            .as_mut()
            .ok_or("missing_stdin")?
            .write_all(b"continue\n")
            .map_err(|_| "continue")
    }
    pub fn kill_and_reap(&mut self) -> Result<(), &'static str> {
        if self.child.try_wait().map_err(|_| "wait")?.is_some() {
            return Err("exited_before_kill");
        }
        self.child.kill().map_err(|_| "kill")?;
        let status = self.wait()?;
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            if status.signal() != Some(libc::SIGKILL) {
                return Err("unexpected_kill_signal");
            }
        }
        if status.success() {
            return Err("unexpected_successful_kill_exit");
        }
        Ok(())
    }
    pub fn wait(&mut self) -> Result<std::process::ExitStatus, &'static str> {
        let deadline = Instant::now() + DEADLINE;
        loop {
            match self.child.try_wait().map_err(|_| "wait")? {
                Some(status) => return Ok(status),
                None if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
                None => return Err("exit_timeout"),
            }
        }
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        // Error paths also terminate only our tracked child; no PID supplied by messages.
        if !matches!(self.child.try_wait(), Ok(Some(_))) {
            let _ = self.child.kill();
            let _ = self.wait();
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_transport_rejects_eof_and_oversize() {
        assert!(read_message(&mut &b"{}"[..]).is_err());
        let huge = vec![b'x'; MAX_MESSAGE + 2];
        assert!(read_message(&mut &huge[..]).is_err());
        assert_eq!(read_message(&mut &b"{}\ntrailing"[..]).unwrap(), b"{}\n");
    }
    #[test]
    fn absent_closed_and_malformed_handshakes_never_count_as_reached() {
        let (sender, receiver) = mpsc::channel();
        assert_eq!(
            receive::<serde_json::Value>(&receiver, Duration::from_millis(1)),
            Err("handshake_timeout")
        );
        sender.send(Ok(b"not-json\n".to_vec())).unwrap();
        assert_eq!(
            receive::<serde_json::Value>(&receiver, Duration::from_millis(1)),
            Err("invalid_message")
        );
        drop(sender);
        assert_eq!(
            receive::<serde_json::Value>(&receiver, Duration::from_millis(1)),
            Err("handshake_closed")
        );
    }
}
