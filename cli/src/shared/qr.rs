// Codificador de codigos QR (ISO/IEC 18004) sin dependencias, modo bytes UTF-8.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ecl {
    L,
    M,
    Q,
    H,
}

impl Ecl {
    const fn ordinal(self) -> usize {
        match self {
            Ecl::L => 0,
            Ecl::M => 1,
            Ecl::Q => 2,
            Ecl::H => 3,
        }
    }

    const fn bits(self) -> u32 {
        match self {
            Ecl::L => 1,
            Ecl::M => 0,
            Ecl::Q => 3,
            Ecl::H => 2,
        }
    }
}

const ECC_CODEWORDS_PER_BLOCK: [[usize; 40]; 4] = [
    [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];

const NUM_ERROR_CORRECTION_BLOCKS: [[usize; 40]; 4] = [
    [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

fn raw_data_modules(ver: usize) -> usize {
    let mut result = (16 * ver + 128) * ver + 64;
    if ver >= 2 {
        let num_align = ver / 7 + 2;
        result -= (25 * num_align - 10) * num_align - 55;
        if ver >= 7 {
            result -= 36;
        }
    }
    result
}

fn data_codewords(ver: usize, ecl: Ecl) -> usize {
    raw_data_modules(ver) / 8
        - ECC_CODEWORDS_PER_BLOCK[ecl.ordinal()][ver - 1]
            * NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal()][ver - 1]
}

fn gf_mul(x: u8, y: u8) -> u8 {
    let x = x as u32;
    let y = y as u32;
    let mut z = 0u32;
    for i in (0..=7).rev() {
        z = (z << 1) ^ ((z >> 7) * 0x11d);
        z ^= ((y >> i) & 1) * x;
    }
    (z & 0xff) as u8
}

fn rs_divisor(degree: usize) -> Vec<u8> {
    let mut result = vec![0u8; degree];
    result[degree - 1] = 1;
    let mut root = 1u8;
    for _ in 0..degree {
        for j in 0..degree {
            result[j] = gf_mul(result[j], root);
            if j + 1 < degree {
                result[j] ^= result[j + 1];
            }
        }
        root = gf_mul(root, 0x02);
    }
    result
}

fn rs_remainder(data: &[u8], divisor: &[u8]) -> Vec<u8> {
    let mut result = vec![0u8; divisor.len()];
    for &b in data {
        let factor = b ^ result[0];
        result.copy_within(1.., 0);
        *result.last_mut().unwrap() = 0;
        for (r, &d) in result.iter_mut().zip(divisor.iter()) {
            *r ^= gf_mul(d, factor);
        }
    }
    result
}

fn encode_data(bytes: &[u8], ver: usize, ecl: Ecl) -> Vec<u8> {
    let mut bits = Vec::<u8>::new();
    let push = |bits: &mut Vec<u8>, val: usize, len: usize| {
        for i in (0..len).rev() {
            bits.push(((val >> i) & 1) as u8);
        }
    };

    push(&mut bits, 0b0100, 4);
    push(&mut bits, bytes.len(), if ver <= 9 { 8 } else { 16 });
    for &b in bytes {
        push(&mut bits, b as usize, 8);
    }

    let capacity = data_codewords(ver, ecl) * 8;
    let term = usize::min(4, capacity - bits.len());
    push(&mut bits, 0, term);
    let align = (8 - bits.len() % 8) % 8;
    push(&mut bits, 0, align);
    let mut pad = 0xecu8;
    while bits.len() < capacity {
        push(&mut bits, pad as usize, 8);
        pad ^= 0xec ^ 0x11;
    }

    let mut out = vec![0u8; bits.len() / 8];
    for (i, &b) in bits.iter().enumerate() {
        out[i >> 3] |= b << (7 - (i & 7));
    }
    out
}

fn add_ecc_and_interleave(data: &[u8], ver: usize, ecl: Ecl) -> Vec<u8> {
    let num_blocks = NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal()][ver - 1];
    let block_ecc_len = ECC_CODEWORDS_PER_BLOCK[ecl.ordinal()][ver - 1];
    let raw_codewords = raw_data_modules(ver) / 8;
    let num_short_blocks = num_blocks - (raw_codewords % num_blocks);
    let short_block_len = raw_codewords / num_blocks;

    let mut blocks = Vec::with_capacity(num_blocks);
    let divisor = rs_divisor(block_ecc_len);
    let mut k = 0;
    for i in 0..num_blocks {
        let dat_len = short_block_len - block_ecc_len + usize::from(i >= num_short_blocks);
        let dat = &data[k..k + dat_len];
        k += dat_len;
        let mut block = vec![0u8; short_block_len + 1];
        block[..dat_len].copy_from_slice(dat);
        let ecc = rs_remainder(dat, &divisor);
        block[short_block_len + 1 - block_ecc_len..].copy_from_slice(&ecc);
        blocks.push(block);
    }

    let mut result = vec![0u8; raw_codewords];
    let mut out_k = 0;
    for i in 0..=short_block_len {
        for (j, block) in blocks.iter().enumerate() {
            if i != short_block_len - block_ecc_len || j >= num_short_blocks {
                result[out_k] = block[i];
                out_k += 1;
            }
        }
    }
    result
}

fn alignment_positions(ver: usize) -> Vec<usize> {
    if ver == 1 {
        return Vec::new();
    }
    let num_align = ver / 7 + 2;
    let size = ver * 4 + 17;
    let step = if ver == 32 {
        26
    } else {
        (ver * 4 + 4).div_ceil(num_align * 2 - 2) * 2
    };
    let mut result = vec![6usize];
    let mut pos = size - 7;
    while result.len() < num_align {
        result.insert(1, pos);
        pos = pos.saturating_sub(step);
    }
    result
}

struct Matrix {
    size: usize,
    modules: Vec<Vec<u8>>,
    is_function: Vec<Vec<bool>>,
}

impl Matrix {
    fn new(size: usize) -> Self {
        Self {
            size,
            modules: vec![vec![0; size]; size],
            is_function: vec![vec![false; size]; size],
        }
    }

    fn set(&mut self, x: usize, y: usize, dark: bool) {
        self.modules[y][x] = u8::from(dark);
        self.is_function[y][x] = true;
    }

    fn draw_finder(&mut self, x: isize, y: isize) {
        let size = self.size as isize;
        for dy in -4isize..=4 {
            for dx in -4isize..=4 {
                let dist = dx.abs().max(dy.abs());
                let xx = x + dx;
                let yy = y + dy;
                if xx >= 0 && xx < size && yy >= 0 && yy < size {
                    self.set(xx as usize, yy as usize, dist != 2 && dist != 4);
                }
            }
        }
    }

    fn draw_alignment(&mut self, x: usize, y: usize) {
        for dy in -2isize..=2 {
            for dx in -2isize..=2 {
                let xx = (x as isize + dx) as usize;
                let yy = (y as isize + dy) as usize;
                self.set(xx, yy, dx.abs().max(dy.abs()) != 1);
            }
        }
    }

    fn draw_format(&mut self, ecl: Ecl, mask: u32) {
        let data = (ecl.bits() << 3) | mask;
        let mut rem = data;
        for _ in 0..10 {
            rem = (rem << 1) ^ ((rem >> 9) * 0x537);
        }
        let bits = ((data << 10) | rem) ^ 0x5412;
        let bit = |i: u32| ((bits >> i) & 1) != 0;
        let n = self.size;

        for i in 0..=5 {
            self.set(8, i, bit(i as u32));
        }
        self.set(8, 7, bit(6));
        self.set(8, 8, bit(7));
        self.set(7, 8, bit(8));
        for i in 9..15 {
            self.set(14 - i, 8, bit(i as u32));
        }

        for i in 0..8 {
            self.set(n - 1 - i, 8, bit(i as u32));
        }
        for i in 8..15 {
            self.set(8, n - 15 + i, bit(i as u32));
        }
        self.set(8, n - 8, true);
    }

    fn draw_version(&mut self, ver: usize) {
        if ver < 7 {
            return;
        }
        let mut rem = ver as u32;
        for _ in 0..12 {
            rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
        }
        let bits = ((ver as u32) << 12) | rem;
        let n = self.size;
        for i in 0..18 {
            let bit = ((bits >> i) & 1) != 0;
            let a = n - 11 + (i % 3);
            let b = i / 3;
            self.set(a, b, bit);
            self.set(b, a, bit);
        }
    }

    fn draw_function_patterns(&mut self, ver: usize, ecl: Ecl) {
        let n = self.size;
        for i in 0..n {
            self.set(6, i, i % 2 == 0);
            self.set(i, 6, i % 2 == 0);
        }
        self.draw_finder(3, 3);
        self.draw_finder(n as isize - 4, 3);
        self.draw_finder(3, n as isize - 4);

        let align = alignment_positions(ver);
        let last = align.len().saturating_sub(1);
        for (i, &ax) in align.iter().enumerate() {
            for (j, &ay) in align.iter().enumerate() {
                if (i == 0 && j == 0) || (i == 0 && j == last) || (i == last && j == 0) {
                    continue;
                }
                self.draw_alignment(ax, ay);
            }
        }
        self.draw_format(ecl, 0);
        self.draw_version(ver);
    }

    fn draw_codewords(&mut self, data: &[u8]) {
        let n = self.size as isize;
        let mut i = 0usize;
        let total_bits = data.len() * 8;
        let mut right = n - 1;
        while right >= 1 {
            if right == 6 {
                right = 5;
            }
            for vert in 0..n {
                for j in 0..2 {
                    let x = (right - j) as usize;
                    let upward = ((right + 1) & 2) == 0;
                    let y = (if upward { n - 1 - vert } else { vert }) as usize;
                    if !self.is_function[y][x] && i < total_bits {
                        self.modules[y][x] = (data[i >> 3] >> (7 - (i & 7))) & 1;
                        i += 1;
                    }
                }
            }
            right -= 2;
        }
    }

    fn apply_mask(&mut self, mask: u32) {
        let n = self.size;
        for y in 0..n {
            for x in 0..n {
                let invert = match mask {
                    0 => (x + y).is_multiple_of(2),
                    1 => y.is_multiple_of(2),
                    2 => x.is_multiple_of(3),
                    3 => (x + y).is_multiple_of(3),
                    4 => (x / 3 + y / 2).is_multiple_of(2),
                    5 => (x * y) % 2 + (x * y) % 3 == 0,
                    6 => ((x * y) % 2 + (x * y) % 3).is_multiple_of(2),
                    _ => ((x + y) % 2 + (x * y) % 3).is_multiple_of(2),
                };
                if !self.is_function[y][x] && invert {
                    self.modules[y][x] ^= 1;
                }
            }
        }
    }

    fn penalty(&self) -> i32 {
        let n = self.size as i32;
        let nu = self.size;
        let m = &self.modules;
        let mut result = 0i32;

        for row in m {
            let mut run_color = 0u8;
            let mut run_x = 0i32;
            let mut history = [0i32; 7];
            for &cell in row {
                if cell == run_color {
                    run_x += 1;
                    if run_x == 5 {
                        result += 3;
                    } else if run_x > 5 {
                        result += 1;
                    }
                } else {
                    finder_penalty_add_history(run_x, &mut history, n);
                    if run_color == 0 {
                        result += finder_penalty_count(&history) * 40;
                    }
                    run_color = cell;
                    run_x = 1;
                }
            }
            result += finder_penalty_terminate(run_color, run_x, &mut history, n) * 40;
        }

        for x in 0..nu {
            let mut run_color = 0u8;
            let mut run_y = 0i32;
            let mut history = [0i32; 7];
            for row in m {
                let cell = row[x];
                if cell == run_color {
                    run_y += 1;
                    if run_y == 5 {
                        result += 3;
                    } else if run_y > 5 {
                        result += 1;
                    }
                } else {
                    finder_penalty_add_history(run_y, &mut history, n);
                    if run_color == 0 {
                        result += finder_penalty_count(&history) * 40;
                    }
                    run_color = cell;
                    run_y = 1;
                }
            }
            result += finder_penalty_terminate(run_color, run_y, &mut history, n) * 40;
        }

        for y in 0..nu - 1 {
            for x in 0..nu - 1 {
                let c = m[y][x];
                if c == m[y][x + 1] && c == m[y + 1][x] && c == m[y + 1][x + 1] {
                    result += 3;
                }
            }
        }

        let dark: i32 = m
            .iter()
            .flat_map(|row| row.iter())
            .map(|&v| v as i32)
            .sum();
        let total = (nu * nu) as i32;
        let k = (((dark * 20 - total * 10).abs() as f64) / (total as f64)).ceil() as i32 - 1;
        result + k * 10
    }
}

fn finder_penalty_count(history: &[i32; 7]) -> i32 {
    let h1 = history[1];
    let core = h1 > 0
        && history[2] == h1
        && history[3] == h1 * 3
        && history[4] == h1
        && history[5] == h1;
    let a = i32::from(core && history[0] >= h1 * 4 && history[6] >= h1);
    let b = i32::from(core && history[6] >= h1 * 4 && history[0] >= h1);
    a + b
}

fn finder_penalty_add_history(mut run: i32, history: &mut [i32; 7], n: i32) {
    if history[0] == 0 {
        run += n;
    }
    history.copy_within(0..6, 1);
    history[0] = run;
}

fn finder_penalty_terminate(color: u8, mut run: i32, history: &mut [i32; 7], n: i32) -> i32 {
    if color == 1 {
        finder_penalty_add_history(run, history, n);
        run = 0;
    }
    run += n;
    finder_penalty_add_history(run, history, n);
    finder_penalty_count(history)
}

#[derive(Debug, Clone)]
pub struct QrCode {
    pub size: usize,
    pub modules: Vec<Vec<u8>>,
    pub version: usize,
    pub mask: u32,
}

pub fn encode_qr(text: &str, ecl: Ecl) -> Result<QrCode, String> {
    let bytes = text.as_bytes();
    let mut ver = 1usize;
    loop {
        if ver > 40 {
            return Err(format!("El texto no cabe en un QR ({} bytes)", bytes.len()));
        }
        let capacity = data_codewords(ver, ecl) * 8;
        let needed = 4 + if ver <= 9 { 8 } else { 16 } + bytes.len() * 8;
        if needed <= capacity {
            break;
        }
        ver += 1;
    }

    let encoded = encode_data(bytes, ver, ecl);
    let data = add_ecc_and_interleave(&encoded, ver, ecl);
    let mut qr = Matrix::new(ver * 4 + 17);
    qr.draw_function_patterns(ver, ecl);
    qr.draw_codewords(&data);

    let mut best = 0u32;
    let mut best_score = i32::MAX;
    for mask in 0..8 {
        qr.apply_mask(mask);
        qr.draw_format(ecl, mask);
        let score = qr.penalty();
        if score < best_score {
            best_score = score;
            best = mask;
        }
        qr.apply_mask(mask);
    }
    qr.apply_mask(best);
    qr.draw_format(ecl, best);

    Ok(QrCode {
        size: qr.size,
        modules: qr.modules,
        version: ver,
        mask: best,
    })
}

pub fn qr_to_svg(qr: &QrCode, quiet: usize, dark: &str, light: &str) -> String {
    let n = qr.size + quiet * 2;
    let mut path = String::new();
    for y in 0..qr.size {
        for (x, &cell) in qr.modules[y].iter().enumerate().take(qr.size) {
            if cell != 0 {
                use std::fmt::Write;
                let _ = write!(path, "M{} {}h1v1h-1z", x + quiet, y + quiet);
            }
        }
    }
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {n} {n}\" shape-rendering=\"crispEdges\" role=\"img\" aria-label=\"QR code\"><rect width=\"{n}\" height=\"{n}\" fill=\"{light}\"/><path d=\"{path}\" fill=\"{dark}\"/></svg>"
    )
}

pub fn qr_to_blocks(qr: &QrCode, quiet: usize, ansi: bool) -> String {
    let n = qr.size + quiet * 2;
    let at = |x: usize, y: usize| -> bool {
        if x < quiet || y < quiet {
            return false;
        }
        let xx = x - quiet;
        let yy = y - quiet;
        if xx >= qr.size || yy >= qr.size {
            return false;
        }
        qr.modules[yy][xx] != 0
    };
    let on = if ansi { "\x1b[47m\x1b[30m" } else { "" };
    let off = if ansi { "\x1b[0m" } else { "" };
    let mut lines = Vec::new();
    for y in (0..n).step_by(2) {
        let mut line = String::with_capacity(on.len() + n * 3 + off.len());
        line.push_str(on);
        for x in 0..n {
            let top = at(x, y);
            let bottom = y + 1 < n && at(x, y + 1);
            let ch = match (top, bottom) {
                (true, true) => '█',
                (true, false) => '▀',
                (false, true) => '▄',
                (false, false) => ' ',
            };
            line.push(ch);
        }
        line.push_str(off);
        lines.push(line);
    }
    lines.join("\n")
}
