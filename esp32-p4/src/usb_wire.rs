use std::time::Duration;

use hx_usb::{Error, Result, Wire};

extern "C" {
    fn helix_usb_close() -> i32;
    fn helix_usb_send(data: *const u8, len: usize, timeout_ms: u32) -> i32;
    fn helix_usb_recv(buf: *mut u8, buf_len: usize, out_len: *mut usize, timeout_ms: u32) -> i32;
}

pub struct EspWire;

impl Drop for EspWire {
    fn drop(&mut self) {
        unsafe {
            helix_usb_close();
        }
    }
}

impl Wire for EspWire {
    fn send(&mut self, bytes: &[u8]) -> Result<()> {
        let rc = unsafe { helix_usb_send(bytes.as_ptr(), bytes.len(), 2000) };
        match rc {
            0 => Ok(()),
            -1 => Err(Error::Usb("write timed out".into())),
            -2 => Err(Error::Usb("usb not open".into())),
            _ => Err(Error::Usb("write failed".into())),
        }
    }

    fn recv(&mut self, timeout: Duration) -> Result<Vec<u8>> {
        let ms = timeout.as_millis().min(u32::MAX as u128) as u32;
        let mut buf = vec![0u8; 512];
        let mut n = 0usize;
        let rc = unsafe { helix_usb_recv(buf.as_mut_ptr(), buf.len(), &mut n, ms) };
        match rc {
            0 => {
                buf.truncate(n);
                Ok(buf)
            }
            // Silence is a timeout, not a dead pipe. Mapping it to Usb made
            // handshake retries and session-loss look like a transport fault.
            -1 => Err(Error::Timeout(0)),
            -2 => Err(Error::Usb("usb not open".into())),
            _ => Err(Error::Usb("read failed".into())),
        }
    }
}
