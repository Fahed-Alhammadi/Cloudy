package io.cloudy.app.data

/** Local-network checks for server addresses: plain http:// is only allowed to hosts that are clearly local. */
object PrivateHost {
    fun isPrivateIp(ip: String): Boolean {
        val v4 = ip.removePrefix("::ffff:")
        return Regex("""^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)""").containsMatchIn(v4) ||
            ip == "::1" || ip.startsWith("fc", true) || ip.startsWith("fd", true) || ip.startsWith("fe80", true)
    }

    /** Hostname that is clearly local: an address in a private range, localhost, or a .local / .lan name. */
    fun isPrivateHost(host: String): Boolean {
        val h = host.lowercase().trim('[', ']')
        if (h == "localhost" || h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".home.arpa")) return true
        return Regex("""^[\d.]+$|:""").containsMatchIn(h) && isPrivateIp(h)
    }
}
