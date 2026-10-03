package com.vrcast.vrcast_remote

import android.graphics.SurfaceTexture
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLExt
import android.opengl.EGLSurface
import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.opengl.Matrix
import android.view.Surface
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Кадр из декодера → вход кодировщика: масштабирование с чёрными полосами и поворот по метке ролика (как `scale` и `pad` у ffmpeg).
 * Все вызовы только из одного потока: контекст OpenGL привязан к нему.
 */
class GlRenderer(encoderSurface: Surface, private val width: Int, private val height: Int) {
    private var display: EGLDisplay = EGL14.EGL_NO_DISPLAY
    private var context: EGLContext = EGL14.EGL_NO_CONTEXT
    private var surface: EGLSurface = EGL14.EGL_NO_SURFACE
    private var program = 0
    private var texture = 0
    private val mvp = FloatArray(16)
    private val textureMatrix = FloatArray(16)
    private val quad: FloatBuffer = ByteBuffer.allocateDirect(16 * 4).order(ByteOrder.nativeOrder()).asFloatBuffer().apply {
        put(floatArrayOf(-1f, -1f, 0f, 0f, 1f, -1f, 1f, 0f, -1f, 1f, 0f, 1f, 1f, 1f, 1f, 1f)); position(0)
    }
    private val frameAvailable = AtomicBoolean(false)
    private val surfaceTexture: SurfaceTexture
    /** Сюда декодер выводит кадры. */
    val decoderSurface: Surface

    init {
        display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
        val version = IntArray(2)
        check(EGL14.eglInitialize(display, version, 0, version, 1)) { "EGL не запустился" }
        val config = arrayOfNulls<EGLConfig>(1)
        val count = IntArray(1)
        val attribs = intArrayOf(EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8, EGL14.EGL_ALPHA_SIZE, 8,
            EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT, EGL_RECORDABLE_ANDROID, 1, EGL14.EGL_NONE)
        check(EGL14.eglChooseConfig(display, attribs, 0, config, 0, 1, count, 0) && count[0] > 0) { "Нет подходящей конфигурации EGL" }
        context = EGL14.eglCreateContext(display, config[0], EGL14.EGL_NO_CONTEXT, intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE), 0)
        surface = EGL14.eglCreateWindowSurface(display, config[0], encoderSurface, intArrayOf(EGL14.EGL_NONE), 0)
        check(EGL14.eglMakeCurrent(display, surface, surface, context)) { "EGL не включился" }

        program = buildProgram()
        val textures = IntArray(1)
        GLES20.glGenTextures(1, textures, 0)
        texture = textures[0]
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, texture)
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
        surfaceTexture = SurfaceTexture(texture)
        surfaceTexture.setOnFrameAvailableListener { frameAvailable.set(true) }
        decoderSurface = Surface(surfaceTexture)
        Matrix.setIdentityM(textureMatrix, 0)
    }

    /** Пришёл ли новый кадр от декодера с прошлого раза. */
    fun hasNewFrame(): Boolean = frameAvailable.get()

    /**
     * Нарисовать кадр в выходное изображение. [hasVideo] — есть ли картинка ролика (иначе чёрный кадр),
     * [srcWidth]×[srcHeight] — размер кадра в декодере, [rotation] — поворот по метке ролика (0, 90, 180, 270).
     */
    fun draw(ptsUs: Long, hasVideo: Boolean, srcWidth: Int, srcHeight: Int, rotation: Int) {
        if (hasVideo && frameAvailable.getAndSet(false)) {
            surfaceTexture.updateTexImage()
            surfaceTexture.getTransformMatrix(textureMatrix)
        }
        GLES20.glViewport(0, 0, width, height)
        GLES20.glClearColor(0f, 0f, 0f, 1f)
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
        if (hasVideo && srcWidth > 0 && srcHeight > 0) {
            letterbox(srcWidth, srcHeight, rotation)
            GLES20.glUseProgram(program)
            GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
            GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, texture)
            GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(program, "uMvp"), 1, false, mvp, 0)
            GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(program, "uTex"), 1, false, textureMatrix, 0)
            val position = GLES20.glGetAttribLocation(program, "aPos")
            val coordinates = GLES20.glGetAttribLocation(program, "aTex")
            quad.position(0)
            GLES20.glVertexAttribPointer(position, 2, GLES20.GL_FLOAT, false, 16, quad)
            GLES20.glEnableVertexAttribArray(position)
            quad.position(2)
            GLES20.glVertexAttribPointer(coordinates, 2, GLES20.GL_FLOAT, false, 16, quad)
            GLES20.glEnableVertexAttribArray(coordinates)
            GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
            GLES20.glDisableVertexAttribArray(position)
            GLES20.glDisableVertexAttribArray(coordinates)
        }
        EGLExt.eglPresentationTimeANDROID(display, surface, ptsUs * 1000)
        EGL14.eglSwapBuffers(display, surface)
    }

    // Кадр вписывается в выход целиком, по краям чёрные полосы; поворот по часовой на rotation градусов.
    private fun letterbox(w: Int, h: Int, rotation: Int) {
        val rotated = rotation % 180 != 0
        val shownW = if (rotated) h else w
        val shownH = if (rotated) w else h
        val k = minOf(width.toFloat() / shownW, height.toFloat() / shownH)
        val unit = maxOf(w, h).toFloat()
        Matrix.setIdentityM(mvp, 0)
        Matrix.scaleM(mvp, 0, k * unit / width, k * unit / height, 1f)
        Matrix.rotateM(mvp, 0, -rotation.toFloat(), 0f, 0f, 1f)
        Matrix.scaleM(mvp, 0, w / unit, h / unit, 1f)
    }

    fun release() {
        try {
            decoderSurface.release()
            surfaceTexture.release()
        } catch (_: Throwable) {
        }
        if (display != EGL14.EGL_NO_DISPLAY) {
            EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
            if (surface != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(display, surface)
            if (context != EGL14.EGL_NO_CONTEXT) EGL14.eglDestroyContext(display, context)
            EGL14.eglReleaseThread()
            EGL14.eglTerminate(display)
        }
        display = EGL14.EGL_NO_DISPLAY
        context = EGL14.EGL_NO_CONTEXT
        surface = EGL14.EGL_NO_SURFACE
    }

    private fun buildProgram(): Int {
        fun compile(type: Int, source: String): Int {
            val shader = GLES20.glCreateShader(type)
            GLES20.glShaderSource(shader, source)
            GLES20.glCompileShader(shader)
            val status = IntArray(1)
            GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, status, 0)
            check(status[0] != 0) { "Шейдер не собрался: ${GLES20.glGetShaderInfoLog(shader)}" }
            return shader
        }
        val vertex = compile(GLES20.GL_VERTEX_SHADER, """
            uniform mat4 uMvp;
            uniform mat4 uTex;
            attribute vec4 aPos;
            attribute vec4 aTex;
            varying vec2 vTex;
            void main() { gl_Position = uMvp * aPos; vTex = (uTex * aTex).xy; }
        """.trimIndent())
        val fragment = compile(GLES20.GL_FRAGMENT_SHADER, """
            #extension GL_OES_EGL_image_external : require
            precision mediump float;
            varying vec2 vTex;
            uniform samplerExternalOES sTex;
            void main() { gl_FragColor = texture2D(sTex, vTex); }
        """.trimIndent())
        val program = GLES20.glCreateProgram()
        GLES20.glAttachShader(program, vertex)
        GLES20.glAttachShader(program, fragment)
        GLES20.glLinkProgram(program)
        val status = IntArray(1)
        GLES20.glGetProgramiv(program, GLES20.GL_LINK_STATUS, status, 0)
        check(status[0] != 0) { "Программа OpenGL не собралась" }
        return program
    }

    private companion object {
        const val EGL_RECORDABLE_ANDROID = 0x3142
    }
}
