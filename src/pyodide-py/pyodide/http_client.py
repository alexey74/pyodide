import email.message
import io
import re
import socket


_UNKNOWN = "UNKNOWN"

# connection states
_CS_IDLE = "Idle"
_CS_REQ_STARTED = "Request-started"
_CS_REQ_SENT = "Request-sent"

# maximal line length when calling readline().
_MAXLINE = 65536
_MAXHEADERS = 100

_is_legal_header_name = re.compile(rb"[^:\s][^:\r\n]*").fullmatch
_is_illegal_header_value = re.compile(rb"\n(?![ \t])|\r(?![ \t\n])").search
_contains_disallowed_url_pchar_re = re.compile("[\x00-\x20\x7f]")

_METHODS_EXPECTING_BODY = {"PATCH", "POST", "PUT"}


def _encode(data, name="data"):
    """Call data.encode("latin-1") but show a better error message."""
    try:
        return data.encode("latin-1")
    except UnicodeEncodeError as err:
        raise UnicodeEncodeError(
            err.encoding,
            err.object,
            err.start,
            err.end,
            "%s (%.20r) is not valid Latin-1. Use %s.encode('utf-8') "
            "if you want to send it encoded in UTF-8."
            % (name.title(), data[err.start : err.end], name),
        ) from None


class HTTPMessage(email.message.Message):
    # XXX The only usage of this method is in
    # http.server.CGIHTTPRequestHandler.  Maybe move the code there so
    # that it doesn't need to be part of the public API.  The API has
    # never been defined so this could cause backwards compatibility
    # issues.

    def getallmatchingheaders(self, name):
        """Find all header lines matching a given header name.

        Look through the list of headers and find all lines matching a given
        header name (and their continuation lines).  A list of the lines is
        returned, without interpretation.  If the header does not occur, an
        empty list is returned.  If the header occurs multiple times, all
        occurrences are returned.  Case is not important in the header name.

        """
        name = name.lower() + ":"
        n = len(name)
        lst = []
        hit = 0
        for line in self.keys():
            if line[:n].lower() == name:
                hit = 1
            elif not line[:1].isspace():
                hit = 0
            if hit:
                lst.append(line)
        return lst


class HTTPResponse(io.BufferedIOBase):

    # See RFC 2616 sec 19.6 and RFC 1945 sec 6 for details.

    # The bytes from the socket object are iso-8859-1 strings.
    # See RFC 2616 sec 2.2 which notes an exception for MIME-encoded
    # text following RFC 2047.  The basic status line parsing only
    # accepts iso-8859-1.

    def __init__(self, sock, debuglevel=0, method=None, url=None, jsresponse=None):
        # If the response includes a content-length header, we need to
        # make sure that the client doesn't read more than the
        # specified number of bytes.  If it does, it will block until
        # the server times out and closes the connection.  This will
        # happen if a self.fp.read() is done (without a size) whether
        # self.fp is buffered or not.  So, no self.fp.read() by
        # clients unless they know what they are doing.
        self.debuglevel = debuglevel
        self._method = method

        # The HTTPResponse object is returned via urllib.  The clients
        # of http and urllib expect different attributes for the
        # headers.  headers is used here and supports urllib.  msg is
        # provided as a backwards compatibility layer for http
        # clients.

        self.headers = self.msg = None

        # from the Status-Line of the response
        self.version = _UNKNOWN  # HTTP-Version
        self.status = _UNKNOWN  # Status-Code
        self.reason = _UNKNOWN  # Reason-Phrase

        self.chunked = _UNKNOWN  # is "chunked" being used?
        self.chunk_left = _UNKNOWN  # bytes left to read in current chunk
        self.length = _UNKNOWN  # number of bytes left in response
        self.will_close = True  # conn will close at end of response
        if jsresponse is None:
            raise RuntimeError("Null JS response")
        self.jsresponse = jsresponse
        if self.debuglevel:
            print("JS Response:", jsresponse)
        status_req = jsresponse.status.schedule_sync()
        reason_req = jsresponse.statusText.schedule_sync()
        headers_req = jsresponse.headers.schedule_sync()

        self.code = self.status = status_req.syncify()

        # FIXME: hangs
        self.reason = ""  # reason_req.syncify()

        self.headers = HTTPMessage()
        for header in headers_req.syncify():
            self.headers.set_raw(*header)

    def begin(self):
        pass

    def close(self):
        pass

    # These implementations are for the benefit of io.BufferedReader.

    # XXX This class should probably be revised to act more like
    # the "raw stream" that BufferedReader expects.

    def flush(self):
        super().flush()
        if self.fp:
            self.fp.flush()

    def readable(self):
        """Always returns True"""
        return True

    # End of "raw stream" methods

    def isclosed(self):
        """True if the connection is closed."""
        # NOTE: it is possible that we will not ever call self.close(). This
        #       case occurs when will_close is TRUE, length is None, and we
        #       read up to the last byte, but NOT past it.
        #
        # IMPLIES: if will_close is FALSE, then self.close() will ALWAYS be
        #          called, meaning self.isclosed() is meaningful.
        pass

    def read(self, amt=None):
        return self.jsresponse.text().syncify()

    def readinto(self, b):
        """Read up to len(b) bytes into bytearray b and return the number
        of bytes read.
        """
        raise NotImplementedError()

    def read1(self, n=-1):
        """Read with at most one underlying system call.  If at least one
        byte is buffered, return that instead.
        """
        raise NotImplementedError()

    def peek(self, n=-1):
        # Having this enables IOBase.readline() to read more than one
        # byte at a time
        raise NotImplementedError()

    def readline(self, limit=-1):
        raise NotImplementedError()

    def fileno(self):
        return self.fp.fileno()

    def getheader(self, name, default=None):
        """Returns the value of the header matching *name*.

        If there are multiple matching headers, the values are
        combined into a single string separated by commas and spaces.

        If no matching header is found, returns *default* or None if
        the *default* is not specified.

        If the headers are unknown, raises http.client.ResponseNotReady.

        """
        if self.headers is None:
            raise ResponseNotReady()
        headers = self.headers.get_all(name) or default
        if isinstance(headers, str) or not hasattr(headers, "__iter__"):
            return headers
        else:
            return ", ".join(headers)

    def getheaders(self):
        """Return list of (header, value) tuples."""
        if self.headers is None:
            raise ResponseNotReady()
        return list(self.headers.items())

    # We override IOBase.__iter__ so that it doesn't check for closed-ness

    def __iter__(self):
        return self

    # For compatibility with old-style urllib responses.

    def info(self):
        return self.headers

    def geturl(self):
        return self.url

    def getcode(self):
        return self.status


class HTTPConnection:
    proto = "http"
    response_class = HTTPResponse
    default_port = ""  # ignored
    auto_open = 1
    debuglevel = 0

    def __init__(
        self,
        host,
        port=None,
        timeout=socket._GLOBAL_DEFAULT_TIMEOUT,
        source_address=None,
        blocksize=8192,
    ):
        self.timeout = timeout
        self.source_address = source_address
        self.blocksize = blocksize
        self.sock = None
        self._buffer = []
        self.__state = _CS_IDLE
        from js import Headers

        self._headers = Headers.new()

        self.__response = None

        (self.host, self.port) = self._get_hostport(host, port)

        # This is stored as an instance variable to allow unit
        # tests to replace it with a suitable mockup
        self._create_connection = socket.create_connection

    def _get_hostport(self, host, port):
        if port is None:
            i = host.rfind(":")
            j = host.rfind("]")  # ipv6 addresses have [...]
            if i > j:
                try:
                    port = int(host[i + 1 :])
                except ValueError:
                    if host[i + 1 :] == "":  # http://foo.com:/ == http://foo.com/
                        port = self.default_port
                    else:
                        raise InvalidURL("nonnumeric port: '%s'" % host[i + 1 :])
                host = host[:i]
            else:
                port = self.default_port
            if host and host[0] == "[" and host[-1] == "]":
                host = host[1:-1]

        return (host, port)

    def set_tunnel(self, host, port=None, headers=None):
        """Set up host and port for HTTP CONNECT tunnelling.

        In a connection that uses HTTP CONNECT tunneling, the host passed to the
        constructor is used as a proxy server that relays all communication to
        the endpoint passed to `set_tunnel`. This done by sending an HTTP
        CONNECT request to the proxy server when the connection is established.

        This method must be called before the HTML connection has been
        established.

        The headers argument should be a mapping of extra HTTP headers to send
        with the CONNECT request.
        """

        pass

    def set_debuglevel(self, level):
        self.debuglevel = level

    def connect(self):
        """Connect to the host and port specified in __init__."""
        pass

    def close(self):
        """Close the connection to the HTTP server."""
        pass

    def send(self, data):
        """Send `data' to the server.
        ``data`` can be a string object, a bytes object, an array object, a
        file-like object that supports a .read() method, or an iterable object.
        """
        pass

    def _output(self, s):
        """Add a line of output to the current request buffer.

        Assumes that the line does *not* end with \\r\\n.
        """
        self._buffer.append(s)

    def putrequest(self, method, url, skip_host=False, skip_accept_encoding=False):
        """Send a request to the server.

        `method' specifies an HTTP request method, e.g. 'GET'.
        `url' specifies the object being requested, e.g. '/index.html'.
        `skip_host' if True does not add automatically a 'Host:' header
        `skip_accept_encoding' if True does not add automatically an
           'Accept-Encoding:' header
        """

        # if a prior response has been completed, then forget about it.
        if self.__response and self.__response.isclosed():
            self.__response = None

        if self.__state == _CS_IDLE:
            self.__state = _CS_REQ_STARTED
        else:
            raise CannotSendRequest(self.__state)

        # Save the method for use later in the response phase
        self._method = method

        url = url or "/"
        self._validate_path(url)
        if url[0] == "/":
            url = url[1:]
        self.url = f"{self.proto}://{self.host}:{self.port}/{url}"

    def _validate_path(self, url):
        """Validate a url for putrequest."""
        # Prevent CVE-2019-9740.
        match = _contains_disallowed_url_pchar_re.search(url)
        if match:
            raise InvalidURL(
                f"URL can't contain control characters. {url!r} "
                f"(found at least {match.group()!r})"
            )

    def putheader(self, header, *values):
        """Send a request header line to the server.

        For example: h.putheader('Accept', 'text/html')
        """
        if self.__state != _CS_REQ_STARTED:
            raise CannotSendHeader()

        if hasattr(header, "encode"):
            header = header.encode("ascii")

        values = list(values)
        for i, one_value in enumerate(values):
            if hasattr(one_value, "encode"):
                values[i] = one_value.encode("latin-1")
            elif isinstance(one_value, int):
                values[i] = str(one_value).encode("ascii")

            if _is_illegal_header_value(values[i]):
                raise ValueError("Invalid header value %r" % (values[i],))

        value = b"\r\n\t".join(values)
        self._headers.append(header.decode(), value.decode())

    def endheaders(self, message_body=None, *, encode_chunked=False):
        """Indicate that the last header line has been sent to the server.

        This method sends the request to the server.  The optional message_body
        argument can be used to pass a message body associated with the
        request.
        """
        if self.__state == _CS_REQ_STARTED:
            self.__state = _CS_REQ_SENT
        else:
            raise CannotSendHeader()
        from js import main_window
        from js import Object, Array

        options = Object.new()
        options.method = self._method
        if message_body is not None:
            options.body = message_body.decode()
        options.headers = getattr(Array, "from")(self._headers)
        options.credentials = "include"
        self._fetch = main_window.fetch(self.url, options).schedule_sync()

    def request(self, method, url, body=None, headers={}, *, encode_chunked=False):
        """Send a complete request to the server."""
        self._send_request(method, url, body, headers, encode_chunked)

    @staticmethod
    def _get_content_length(body, method):
        """Get the content-length based on the body.

        If the body is None, we set Content-Length: 0 for methods that expect
        a body (RFC 7230, Section 3.3.2). We also set the Content-Length for
        any method if the body is a str or bytes-like object and not a file.
        """
        if body is None:
            # do an explicit check for not None here to distinguish
            # between unset and set but empty
            if method.upper() in _METHODS_EXPECTING_BODY:
                return 0
            else:
                return None

        if hasattr(body, "read"):
            # file-like object.
            return None

        try:
            # does it implement the buffer protocol (bytes, bytearray, array)?
            mv = memoryview(body)
            return mv.nbytes
        except TypeError:
            pass

        if isinstance(body, str):
            return len(body)

        return None

    def _send_request(self, method, url, body, headers, encode_chunked):
        # Honor explicitly requested Host: and Accept-Encoding: headers.
        header_names = frozenset(k.lower() for k in headers)
        skips = {}
        if "host" in header_names:
            skips["skip_host"] = 1
        if "accept-encoding" in header_names:
            skips["skip_accept_encoding"] = 1

        self.putrequest(method, url, **skips)

        # chunked encoding will happen if HTTP/1.1 is used and either
        # the caller passes encode_chunked=True or the following
        # conditions hold:
        # 1. content-length has not been explicitly set
        # 2. the body is a file or iterable, but not a str or bytes-like
        # 3. Transfer-Encoding has NOT been explicitly set by the caller

        if "content-length" not in header_names:
            # only chunk body if not explicitly set for backwards
            # compatibility, assuming the client code is already handling the
            # chunking
            if "transfer-encoding" not in header_names:
                # if content-length cannot be automatically determined, fall
                # back to chunked encoding
                encode_chunked = False
                content_length = self._get_content_length(body, method)
                if content_length is None:
                    if body is not None:
                        if self.debuglevel > 0:
                            print("Unable to determine size of %r" % body)
                        encode_chunked = True
                        self.putheader("Transfer-Encoding", "chunked")
                else:
                    self.putheader("Content-Length", str(content_length))
        else:
            encode_chunked = False

        for hdr, value in headers.items():
            self.putheader(hdr, value)
        if isinstance(body, str):
            # RFC 2616 Section 3.7.1 says that text default has a
            # default charset of iso-8859-1.
            body = _encode(body, "body")
        self.endheaders(body, encode_chunked=encode_chunked)

    def getresponse(self):
        """Get the response from the server.

        If the HTTPConnection is in the correct state, returns an
        instance of HTTPResponse or of whatever object is returned by
        the response_class variable.

        If a request has not been sent or if a previous response has
        not be handled, ResponseNotReady is raised.  If the HTTP
        response indicates that the connection should be closed, then
        it will be closed before the response is returned.  When the
        connection is closed, the underlying socket is closed.
        """

        # if a prior response has been completed, then forget about it.
        if self.__response and self.__response.isclosed():
            self.__response = None

        # if a prior response exists, then it must be completed (otherwise, we
        # cannot read this response's header to determine the connection-close
        # behavior)
        #
        # note: if a prior response existed, but was connection-close, then the
        # socket and response were made independent of this HTTPConnection
        # object since a new request requires that we open a whole new
        # connection
        #
        # this means the prior response had one of two states:
        #   1) will_close: this connection was reset and the prior socket and
        #                  response operate independently
        #   2) persistent: the response was retained and we await its
        #                  isclosed() status to become true.
        #
        if self.__state != _CS_REQ_SENT or self.__response:
            raise ResponseNotReady(self.__state)

        jsresponse = self._fetch.syncify()
        print("fetched resp:", jsresponse)
        if self.debuglevel > 0:
            response = self.response_class(
                self.sock, self.debuglevel, method=self._method, jsresponse=jsresponse
            )
        else:
            response = self.response_class(
                self.sock, method=self._method, jsresponse=jsresponse
            )
        print("constructed resp:", response)
        try:
            try:
                response.begin()
            except ConnectionError:
                self.close()
                raise
            assert response.will_close != _UNKNOWN
            self.__state = _CS_IDLE

            if response.will_close:
                # this effectively passes the connection to the response
                self.close()
            else:
                # remember this, so we can tell when it is complete
                self.__response = response

            print("resp:", response)
            return response
        except:
            response.close()
            raise


class HTTPSConnection(HTTPConnection):
    proto = "https"


class HTTPException(Exception):
    # Subclasses that define an __init__ must call Exception.__init__
    # or define self.args.  Otherwise, str() will fail.
    pass


class NotConnected(HTTPException):
    pass


class InvalidURL(HTTPException):
    pass


class ImproperConnectionState(HTTPException):
    pass


class CannotSendRequest(ImproperConnectionState):
    pass


class CannotSendHeader(ImproperConnectionState):
    pass


class ResponseNotReady(ImproperConnectionState):
    pass


class LineTooLong(HTTPException):
    def __init__(self, line_type):
        HTTPException.__init__(
            self, "got more than %d bytes when reading %s" % (_MAXLINE, line_type)
        )
