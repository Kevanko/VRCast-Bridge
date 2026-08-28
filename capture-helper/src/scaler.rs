// Масштабирование и перевод кадра в NV12 силами видеокарты.
//
// Раньше кадр забирался в оперативную память целиком и уменьшался вручную
// методом ближайшего соседа: 55 миллионов попиксельных копирований в секунду на
// одном ядре для 720p60 и лесенка на краях. Через канал при этом шло 221 МБ/с
// сырого BGRA, который ffmpeg тут же переводил в NV12 — снова на процессоре.
//
// Видеопроцессор Direct3D делает и то, и другое даром: билинейное уменьшение,
// поля вокруг кадра и сразу нужный формат. Через канал идёт втрое меньше.
use windows::core::Interface;
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12, DXGI_RATIONAL, DXGI_SAMPLE_DESC};

pub struct Scaler {
    video_device: ID3D11VideoDevice,
    video_context: ID3D11VideoContext,
    processor: ID3D11VideoProcessor,
    enumerator: ID3D11VideoProcessorEnumerator,
    output: ID3D11Texture2D,
    output_view: ID3D11VideoProcessorOutputView,
    staging: ID3D11Texture2D,
    pub width: u32,
    pub height: u32,
    source_width: u32,
    source_height: u32,
}

fn texture(device: &ID3D11Device, width: u32, height: u32, staging: bool) -> windows::core::Result<ID3D11Texture2D> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_NV12,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: if staging { D3D11_USAGE_STAGING } else { D3D11_USAGE_DEFAULT },
        BindFlags: if staging { 0 } else { D3D11_BIND_RENDER_TARGET.0 as u32 },
        CPUAccessFlags: if staging { D3D11_CPU_ACCESS_READ.0 as u32 } else { 0 },
        MiscFlags: 0,
    };
    let mut result = None;
    unsafe { device.CreateTexture2D(&desc, None, Some(&mut result))?; }
    Ok(result.unwrap())
}

impl Scaler {
    pub fn new(device: &ID3D11Device, context: &ID3D11DeviceContext,
               source_width: u32, source_height: u32, width: u32, height: u32) -> windows::core::Result<Self> {
        let video_device: ID3D11VideoDevice = device.cast()?;
        let video_context: ID3D11VideoContext = context.cast()?;
        let описание = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: DXGI_RATIONAL { Numerator: 60, Denominator: 1 },
            InputWidth: source_width.max(1),
            InputHeight: source_height.max(1),
            OutputFrameRate: DXGI_RATIONAL { Numerator: 60, Denominator: 1 },
            OutputWidth: width,
            OutputHeight: height,
            Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
        };
        let enumerator = unsafe { video_device.CreateVideoProcessorEnumerator(&описание)? };
        let processor = unsafe { video_device.CreateVideoProcessor(&enumerator, 0)? };
        let output = texture(device, width, height, false)?;
        let mut output_view = None;
        let вид = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
            ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
            ..Default::default()
        };
        unsafe { video_device.CreateVideoProcessorOutputView(&output, &enumerator, &вид, Some(&mut output_view))?; }
        let staging = texture(device, width, height, true)?;
        // Поля вокруг кадра — тот же тёмный цвет, что и раньше рисовался вручную.
        let фон = D3D11_VIDEO_COLOR {
            Anonymous: D3D11_VIDEO_COLOR_0 {
                RGBA: D3D11_VIDEO_COLOR_RGBA { R: 0.141, G: 0.125, B: 0.173, A: 1.0 },
            },
        };
        unsafe { video_context.VideoProcessorSetOutputBackgroundColor(&processor, false, &фон); }
        Ok(Self { video_device, video_context, processor, enumerator, output,
            output_view: output_view.unwrap(), staging, width, height, source_width, source_height })
    }

    pub fn source_width(&self) -> u32 { self.source_width }
    pub fn source_height(&self) -> u32 { self.source_height }

    /// Вписывает кадр в выходной размер с сохранением пропорций и переводит в NV12.
    pub fn blit(&mut self, device: &ID3D11Device, context: &ID3D11DeviceContext,
                source: &ID3D11Texture2D, content_width: u32, content_height: u32,
                out: &mut [u8]) -> windows::core::Result<()> {
        let mut input_view = None;
        let вид = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
            FourCC: 0,
            ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
                Texture2D: D3D11_TEX2D_VPIV { MipSlice: 0, ArraySlice: 0 },
            },
        };
        unsafe { self.video_device.CreateVideoProcessorInputView(source, &self.enumerator, &вид, Some(&mut input_view))?; }

        let ширина = content_width.max(1).min(self.source_width);
        let высота = content_height.max(1).min(self.source_height);
        let масштаб = (self.width as f64 / ширина as f64).min(self.height as f64 / высота as f64);
        // Чётные размеры: у NV12 цветовая плоскость вдвое меньше.
        let вписано_ш = (((ширина as f64 * масштаб).round() as u32).max(2).min(self.width) / 2) * 2;
        let вписано_в = (((высота as f64 * масштаб).round() as u32).max(2).min(self.height) / 2) * 2;
        let отступ_x = ((self.width - вписано_ш) / 2 / 2) * 2;
        let отступ_y = ((self.height - вписано_в) / 2 / 2) * 2;

        unsafe {
            self.video_context.VideoProcessorSetStreamSourceRect(&self.processor, 0, true,
                Some(&RECT { left: 0, top: 0, right: ширина as i32, bottom: высота as i32 }));
            self.video_context.VideoProcessorSetStreamDestRect(&self.processor, 0, true,
                Some(&RECT { left: отступ_x as i32, top: отступ_y as i32,
                    right: (отступ_x + вписано_ш) as i32, bottom: (отступ_y + вписано_в) as i32 }));
            let поток = D3D11_VIDEO_PROCESSOR_STREAM {
                Enable: true.into(),
                OutputIndex: 0,
                InputFrameOrField: 0,
                pInputSurface: std::mem::ManuallyDrop::new(input_view.clone()),
                ..Default::default()
            };
            self.video_context.VideoProcessorBlt(&self.processor, &self.output_view, 0, &[поток])?;
            context.CopyResource(&self.staging, &self.output);
        }

        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe { context.Map(&self.staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?; }
        let шаг = mapped.RowPitch as usize;
        let ш = self.width as usize;
        let в = self.height as usize;
        unsafe {
            let основа = mapped.pData as *const u8;
            for строка in 0..в {
                let источник = std::slice::from_raw_parts(основа.add(строка * шаг), ш);
                out[строка * ш..строка * ш + ш].copy_from_slice(источник);
            }
            // Цветовая плоскость лежит сразу за яркостной.
            let цвет = основа.add(в * шаг);
            let сдвиг = в * ш;
            for строка in 0..в / 2 {
                let источник = std::slice::from_raw_parts(цвет.add(строка * шаг), ш);
                out[сдвиг + строка * ш..сдвиг + строка * ш + ш].copy_from_slice(источник);
            }
            context.Unmap(&self.staging, 0);
        }
        let _ = device;
        Ok(())
    }
}

/// Сколько байт занимает кадр NV12 указанного размера.
pub fn nv12_size(width: u32, height: u32) -> usize {
    (width as usize * height as usize) * 3 / 2
}

pub const _BGRA: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT = DXGI_FORMAT_B8G8R8A8_UNORM;
