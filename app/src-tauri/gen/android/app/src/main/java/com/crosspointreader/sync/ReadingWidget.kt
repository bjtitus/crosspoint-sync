package com.crosspointreader.sync

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.view.View
import android.widget.RemoteViews
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.text.NumberFormat
import java.util.TimeZone
import kotlin.math.max
import kotlin.math.roundToInt

// Home screen widget: the current book and reading totals. The app pushes the
// data through window.CrossPointWidget.update (MainActivity) whenever it loads,
// including the session; every 30 minutes (updatePeriodMillis) the widget also
// refreshes it from the sync server on its own.
class ReadingWidget : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    ids.forEach { manager.updateAppWidget(it, render(context)) }
    // Network off the main thread; goAsync keeps the receiver alive until it's done.
    val pending = goAsync()
    Thread {
      try {
        if (fetch(context)) refresh(context)
      } catch (_: Exception) {
        // Offline or signed out: keep showing the last snapshot.
      } finally {
        pending.finish()
      }
    }.start()
  }

  companion object {
    const val PREFS = "reading_widget"
    const val COVER = "widget_cover.png"

    private fun get(session: JSONObject, path: String): JSONObject? {
      val conn = URL(session.getString("server") + path).openConnection() as HttpURLConnection
      conn.connectTimeout = 15_000
      conn.readTimeout = 15_000
      conn.setRequestProperty("x-auth-user", session.getString("username"))
      conn.setRequestProperty("x-auth-key", session.getString("key"))
      conn.setRequestProperty("accept", "application/json")
      return try {
        if (conn.responseCode == 200) JSONObject(conn.inputStream.bufferedReader().readText()) else null
      } finally {
        conn.disconnect()
      }
    }

    // The same text the app writes (app/src/widget.js). Returns whether anything was saved.
    private fun fetch(context: Context): Boolean {
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val data = prefs.getString("data", null)?.let { JSONObject(it) } ?: return false
      val session = data.optJSONObject("session") ?: return false
      val items = get(session, "/api/v1/progress?limit=500")?.optJSONArray("items") ?: return false
      val tz = -TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 60_000
      get(session, "/api/v1/stats/overview?tz=$tz")?.let { o ->
        val seconds = o.optDouble("seconds", 0.0)
        data.put("stats", if (seconds > 0) "${o.optInt("current_streak")}-day streak · ${(seconds / 3600).roundToInt()}h read"
          else "${NumberFormat.getIntegerInstance().format(o.optInt("pages_read"))} pages · ${o.optInt("finished_this_year")} finished this year")
      }
      val current = (0 until items.length()).map { items.getJSONObject(it) }.firstOrNull {
        it.optString("status") == "reading" && (title(it) != null)
      }
      if (current != null) {
        data.put("label", "CONTINUE READING").put("title", title(current)).put("author", current.optString("author").takeUnless { current.isNull("author") } ?: "")
          .put("percent", (current.optDouble("percentage", 0.0) * 100).roundToInt())
      } else {
        data.put("label", "CROSSPOINT SYNC").put("title", "Nothing in progress").put("author", "").put("percent", -1)
      }
      val coverUrl = current?.takeUnless { it.isNull("cover_url") }?.optString("cover_url")
      val oldCover = data.takeUnless { it.isNull("cover_url") }?.optString("cover_url")
      if (coverUrl != oldCover) {
        val file = File(context.filesDir, COVER)
        file.delete()
        coverUrl?.let { link -> runCatching { coverPng(link)?.let { file.writeBytes(it) } } }
        data.put("cover_url", coverUrl ?: JSONObject.NULL)
      }
      prefs.edit().putString("data", data.toString()).apply()
      return true
    }

    private fun title(book: JSONObject): String? =
      listOf("title", "filename").firstNotNullOfOrNull { k -> book.takeUnless { it.isNull(k) }?.optString(k)?.takeIf { it.isNotEmpty() } }

    // Widget-sized (168x252, cropped to fill like the app does): widget bitmaps travel over IPC.
    private fun coverPng(link: String): ByteArray? {
      val conn = URL(link).openConnection() as HttpURLConnection
      conn.connectTimeout = 15_000
      conn.readTimeout = 15_000
      val src = try {
        if (conn.responseCode != 200) return null
        BitmapFactory.decodeStream(conn.inputStream)
      } finally {
        conn.disconnect()
      } ?: return null
      val out = Bitmap.createBitmap(168, 252, Bitmap.Config.ARGB_8888)
      val s = max(168f / src.width, 252f / src.height)
      val w = src.width * s
      val h = src.height * s
      Canvas(out).drawBitmap(src, null, android.graphics.RectF((168 - w) / 2, (252 - h) / 2, (168 + w) / 2, (252 + h) / 2), null)
      return java.io.ByteArrayOutputStream().also { out.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    }

    fun refresh(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      val ids = manager.getAppWidgetIds(ComponentName(context, ReadingWidget::class.java))
      ids.forEach { manager.updateAppWidget(it, render(context)) }
    }

    private fun render(context: Context): RemoteViews {
      val views = RemoteViews(context.packageName, R.layout.reading_widget)
      val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("data", null)
      val data = raw?.let { runCatching { JSONObject(it) }.getOrNull() }
      if (data == null) {
        views.setTextViewText(R.id.widget_label, "CROSSPOINT SYNC")
        views.setTextViewText(R.id.widget_title, "Open the app to sign in")
        views.setViewVisibility(R.id.widget_progress, View.GONE)
      } else {
        val percent = data.optInt("percent", -1)
        views.setTextViewText(R.id.widget_label, data.optString("label", "CONTINUE READING"))
        views.setTextViewText(R.id.widget_title, data.optString("title"))
        views.setTextViewText(R.id.widget_author, data.optString("author"))
        views.setTextViewText(R.id.widget_stats, data.optString("stats"))
        if (percent >= 0) {
          views.setViewVisibility(R.id.widget_progress, View.VISIBLE)
          views.setProgressBar(R.id.widget_progress, 100, percent, false)
          views.setTextViewText(R.id.widget_percent, "$percent%")
        } else {
          views.setViewVisibility(R.id.widget_progress, View.GONE)
          views.setTextViewText(R.id.widget_percent, "")
        }
      }
      val cover = File(context.filesDir, COVER)
      val bitmap = if (data != null && cover.exists()) {
        // Downsample: widget bitmaps travel over IPC and must stay small.
        BitmapFactory.decodeFile(cover.path, BitmapFactory.Options().apply { inSampleSize = 2 })
      } else null
      if (bitmap != null) {
        views.setViewVisibility(R.id.widget_cover, View.VISIBLE)
        views.setImageViewBitmap(R.id.widget_cover, bitmap)
      } else {
        views.setViewVisibility(R.id.widget_cover, View.GONE)
      }
      val open = PendingIntent.getActivity(
        context, 0, Intent(context, MainActivity::class.java),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
      views.setOnClickPendingIntent(R.id.widget_root, open)
      return views
    }
  }
}
