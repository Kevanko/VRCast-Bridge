mod scaler;

use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use windows::core::{factory, Interface, Result};
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::{HMODULE, HWND, RECT};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, IsIconic, IsWindow};

fn argument(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|value| value == name).and_then(|index| args.get(index + 1).cloned())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Window capture: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let hwnd_value = argument("--hwnd").and_then(|v| v.parse::<isize>().ok()).filter(|v| *v != 0)
        .ok_or_else(|| windows::core::Error::new(windows::core::HRESULT(0x80070057u32 as i32), "Не указан HWND"))?;
    let hwnd = HWND(hwnd_value as *mut _);
    if std::env::args().any(|value| value == "--state") {
        let mut rect = RECT::default();
        let exists = unsafe { IsWindow(Some(hwnd)).as_bool() };
        let minimized = exists && unsafe { IsIconic(hwnd).as_bool() };
        let has_rect = exists && unsafe { GetWindowRect(hwnd, &mut rect).is_ok() };
        println!("{{\"exists\":{},\"minimized\":{},\"x\":{},\"y\":{},\"width\":{},\"height\":{}}}",
            exists, minimized, rect.left, rect.top,
            if has_rect { rect.right - rect.left } else { 0 }, if has_rect { rect.bottom - rect.top } else { 0 });
        return Ok(());
    }
    // Лёгкое наблюдение: ни захвата, ни видеокарты — только сообщения о том,
    // что окно свернули, развернули или закрыли. Нужен, пока окно свёрнуто:
    // захват в это время не идёт, а узнать о возвращении окна как-то надо.
    if std::env::args().any(|value| value == "--watch") {
        let mut последнее = "";
        loop {
            let существует = unsafe { IsWindow(Some(hwnd)).as_bool() };
            let свёрнуто = существует && unsafe { IsIconic(hwnd).as_bool() };
            let состояние = if !существует { "gone" } else if свёрнуто { "minimized" } else { "visible" };
            if состояние != последнее {
                последнее = состояние;
                eprintln!("state={состояние}");
                if !существует { return Ok(()); }
            }
            thread::sleep(Duration::from_millis(400));
        }
    }
    unsafe { RoInitialize(RO_INIT_MULTITHREADED)?; }
    let output_width = argument("--width").and_then(|v| v.parse::<u32>().ok()).unwrap_or(1280).max(64);
    let output_height = argument("--height").and_then(|v| v.parse::<u32>().ok()).unwrap_or(720).max(64);
    let fps = argument("--fps").and_then(|v| v.parse::<u32>().ok()).unwrap_or(30).clamp(1, 120);

    let mut device = None;
    let mut context = None;
    unsafe {
        D3D11CreateDevice(None, D3D_DRIVER_TYPE_HARDWARE, HMODULE::default(), D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&[D3D_FEATURE_LEVEL_11_0]), D3D11_SDK_VERSION, Some(&mut device), None, Some(&mut context))?;
    }
    let device = device.unwrap();
    let context = context.unwrap();
    let dxgi_device: IDXGIDevice = device.cast()?;
    let inspectable = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi_device)? };
    let winrt_device: IDirect3DDevice = inspectable.cast()?;

    let interop: IGraphicsCaptureItemInterop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
    let item: GraphicsCaptureItem = unsafe { interop.CreateForWindow(hwnd)? };
    let item_size = item.Size()?;
    let frame_pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        &winrt_device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, item_size)?;
    let session = frame_pool.CreateCaptureSession(&item)?;
    let _ = session.SetIsCursorCaptureEnabled(true);
    session.StartCapture()?;

    let mut texture_desc = D3D11_TEXTURE2D_DESC {
        Width: item_size.Width.max(1) as u32,
        Height: item_size.Height.max(1) as u32,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_STAGING,
        BindFlags: 0,
        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
        MiscFlags: 0,
    };
    let mut staging = None;
    unsafe { device.CreateTexture2D(&texture_desc, None, Some(&mut staging))?; }
    let mut staging = staging.unwrap();
    let mut pool_size = item_size;
    let mut last_size_check = Instant::now();

    // Масштабирование и перевод в NV12 отдаём видеокарте. Если она этого не
    // умеет (старый драйвер, программный адаптер), остаётся прежний путь через
    // процессор — он медленнее, но работает везде.
    let mut gpu = scaler::Scaler::new(&device, &context,
        texture_desc.Width, texture_desc.Height, output_width, output_height).ok();
    if gpu.is_none() { eprintln!("GPU scaling unavailable, using CPU path"); }
    let mut gpu_errors = 0u32;
    let mut последнее_состояние = "visible";
    // Кадр уходит в NV12: яркость плюс вдвое меньшая цветовая плоскость.
    // Это втрое меньше данных через канал, чем сырой BGRA, и ровно тот формат,
    // который нужен кодировщику — лишнего перевода уже не будет.
    let mut latest = vec![0u8; scaler::nv12_size(output_width, output_height)];
    let серый = output_width as usize * output_height as usize;
    for byte in latest[..серый].iter_mut() { *byte = 20; }
    for byte in latest[серый..].iter_mut() { *byte = 128; }
    let mut bgra = vec![0u8; output_width as usize * output_height as usize * 4];

    // Пока мы держим сессию захвата, Windows рисует вокруг окна жёлтую рамку и
    // сама её убирает, когда сессия закрыта. При жёстком убийстве процесса
    // закрытия не происходит, и рамка оставалась висеть на окне ещё долго после
    // выхода из программы. Поэтому слушаем свой ввод: как только тот, кто нас
    // запустил, закрывает канал, выходим сами — и рамка исчезает вместе с нами.
    let stop = Arc::new(AtomicBool::new(false));
    {
        let stop = Arc::clone(&stop);
        thread::spawn(move || {
            let mut probe = [0u8; 1];
            let mut input = io::stdin();
            while let Ok(read) = input.read(&mut probe) {
                if read == 0 { break; }
            }
            stop.store(true, Ordering::Relaxed);
        });
    }

    let frame_duration = Duration::from_secs_f64(1.0 / fps as f64);
    let mut next_frame = Instant::now();
    let capture_started = Instant::now();
    let mut has_frame = false;
    let mut stdout = io::BufWriter::with_capacity(latest.len() * 2, io::stdout().lock());
    loop {
        if stop.load(Ordering::Relaxed) { break; }
        // Окно поменяло размер — пересоздаём только пул кадров и приёмник.
        // Раньше про это узнавала программа снаружи и перезапускала захват
        // целиком: новый процесс, новый кодировщик, разрыв в эфире на секунду.
        // Здесь же смена размера обходится одним кадром.
        // Размер спрашиваем не чаще четырёх раз в секунду. Этот вопрос уходит
        // в поток чужого окна, и пока окно тащат за угол, ответа можно ждать
        // долго — цикл захвата вставал вместе с ним, и эфир замирал на всё
        // время перетаскивания.
        let пора_проверить = last_size_check.elapsed() >= Duration::from_millis(250);
        if пора_проверить {
            last_size_check = Instant::now();
            // О сворачивании и закрытии окна сообщаем сами. Раньше об этом
            // спрашивал отдельный процесс раз в три секунды — лишний запуск
            // на ровном месте, притом что мы держим окно и знаем о нём всё.
            let существует = unsafe { IsWindow(Some(hwnd)).as_bool() };
            let свёрнуто = существует && unsafe { IsIconic(hwnd).as_bool() };
            let состояние = if !существует { "gone" } else if свёрнуто { "minimized" } else { "visible" };
            if состояние != последнее_состояние {
                последнее_состояние = состояние;
                eprintln!("state={состояние}");
                if !существует { break; }
            }
        }
        if let Ok(current) = (if пора_проверить { item.Size() } else { Ok(pool_size) }) {
            if (current.Width != pool_size.Width || current.Height != pool_size.Height)
                && current.Width > 0 && current.Height > 0
            {
                if frame_pool.Recreate(&winrt_device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, current).is_ok() {
                    let mut desc = texture_desc;
                    desc.Width = current.Width.max(1) as u32;
                    desc.Height = current.Height.max(1) as u32;
                    let mut next = None;
                    if unsafe { device.CreateTexture2D(&desc, None, Some(&mut next)) }.is_ok() {
                        if let Some(next) = next {
                            staging = next;
                            texture_desc = desc;
                            pool_size = current;
                            gpu = scaler::Scaler::new(&device, &context,
                                texture_desc.Width, texture_desc.Height, output_width, output_height).ok();
                        }
                    }
                }
            }
        }
        if let Ok(frame) = frame_pool.TryGetNextFrame() {
            let surface = frame.Surface()?;
            let access: IDirect3DDxgiInterfaceAccess = surface.cast()?;
            let source: ID3D11Texture2D = unsafe { access.GetInterface()? };
            let content = frame.ContentSize()?;
            if let Some(масштабатор) = gpu.as_mut() {
                // Размер входа берём у самого кадра: сразу после пересоздания
                // пула в очереди может лежать кадр прежнего размера, и
                // видеопроцессор такой вход не принимает.
                let mut описание = D3D11_TEXTURE2D_DESC::default();
                unsafe { source.GetDesc(&mut описание); }
                if описание.Width != масштабатор.source_width() || описание.Height != масштабатор.source_height() {
                    gpu = scaler::Scaler::new(&device, &context, описание.Width, описание.Height,
                        output_width, output_height).ok();
                }
                let итог = gpu.as_mut().map(|м| м.blit(&device, &context, &source,
                    content.Width.max(1) as u32, content.Height.max(1) as u32, &mut latest));
                match итог {
                    Some(Ok(())) => { has_frame = true; gpu_errors = 0; }
                    Some(Err(ошибка)) => {
                        gpu_errors += 1;
                        // Одиночный отказ — это кадр не того размера на стыке,
                        // такой просто пропускаем. Пять подряд означают, что
                        // видеокарта этого не умеет: уходим на процессор.
                        if gpu_errors >= 5 {
                            eprintln!("GPU scaling failed ({ошибка}), switching to CPU path");
                            gpu = None;
                        }
                    }
                    None => {}
                }
            }
            if gpu.is_none() {
            unsafe { context.CopyResource(&staging, &source); }
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            if unsafe { context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) }.is_ok() {
                let source_width = (content.Width.max(1) as u32).min(texture_desc.Width) as usize;
                let source_height = (content.Height.max(1) as u32).min(texture_desc.Height) as usize;
                let scale = (output_width as f64 / source_width as f64).min(output_height as f64 / source_height as f64);
                let scaled_width = ((source_width as f64 * scale).round() as usize).max(1).min(output_width as usize);
                let scaled_height = ((source_height as f64 * scale).round() as usize).max(1).min(output_height as usize);
                let offset_x = (output_width as usize - scaled_width) / 2;
                let offset_y = (output_height as usize - scaled_height) / 2;
                for pixel in bgra.chunks_exact_mut(4) { pixel.copy_from_slice(&[0x2c, 0x20, 0x24, 0xff]); }
                for destination_y in 0..scaled_height {
                    let source_y = destination_y * source_height / scaled_height;
                    let source_row = unsafe { std::slice::from_raw_parts((mapped.pData as *const u8).add(source_y * mapped.RowPitch as usize), source_width * 4) };
                    let destination_row = (destination_y + offset_y) * output_width as usize * 4;
                    for destination_x in 0..scaled_width {
                        let source_x = destination_x * source_width / scaled_width;
                        let source_offset = source_x * 4;
                        let destination_offset = destination_row + (destination_x + offset_x) * 4;
                        bgra[destination_offset..destination_offset + 4].copy_from_slice(&source_row[source_offset..source_offset + 4]);
                    }
                }
                unsafe { context.Unmap(&staging, 0); }
                bgra_to_nv12(&bgra, output_width as usize, output_height as usize, &mut latest);
                has_frame = true;
            }
            }
        }
        let now = Instant::now();
        if now >= next_frame && (has_frame || capture_started.elapsed() >= Duration::from_secs(1)) {
            if stdout.write_all(&latest).is_err() || stdout.flush().is_err() { break; }
            next_frame += frame_duration;
            if next_frame + frame_duration < now { next_frame = now + frame_duration; }
        } else {
            thread::sleep(Duration::from_millis(1));
        }
    }
    // Явно закрываем сессию и пул: так Windows снимает жёлтую рамку сразу,
    // а не когда доберётся до окна следующая перерисовка.
    let _ = session.Close();
    let _ = frame_pool.Close();
    Ok(())
}

// Запасной путь: перевод BGRA в NV12 на процессоре по BT.601 — тем же
// уравнением, каким это сделал бы ffmpeg, если бы получал сырой BGRA.
fn bgra_to_nv12(bgra: &[u8], width: usize, height: usize, out: &mut [u8]) {
    let плоскость = width * height;
    for y in 0..height {
        for x in 0..width {
            let p = (y * width + x) * 4;
            let (b, g, r) = (bgra[p] as f32, bgra[p + 1] as f32, bgra[p + 2] as f32);
            let яркость = 16.0 + 0.257 * r + 0.504 * g + 0.098 * b;
            out[y * width + x] = яркость.clamp(0.0, 255.0) as u8;
        }
    }
    for y in (0..height).step_by(2) {
        for x in (0..width).step_by(2) {
            let mut сумма = (0.0f32, 0.0f32, 0.0f32);
            for (dy, dx) in [(0, 0), (0, 1), (1, 0), (1, 1)] {
                let p = ((y + dy).min(height - 1) * width + (x + dx).min(width - 1)) * 4;
                сумма.0 += bgra[p] as f32;
                сумма.1 += bgra[p + 1] as f32;
                сумма.2 += bgra[p + 2] as f32;
            }
            let (b, g, r) = (сумма.0 / 4.0, сумма.1 / 4.0, сумма.2 / 4.0);
            let u = 128.0 - 0.148 * r - 0.291 * g + 0.439 * b;
            let v = 128.0 + 0.439 * r - 0.368 * g - 0.071 * b;
            let сдвиг = плоскость + (y / 2) * width + x;
            out[сдвиг] = u.clamp(0.0, 255.0) as u8;
            out[сдвиг + 1] = v.clamp(0.0, 255.0) as u8;
        }
    }
}
