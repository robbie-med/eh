"""Self-check for the read-only page parsers, on trimmed copies of e-value's markup (no real data).
Run: python proxy/test_views.py"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import app  # noqa: E402

Q = '<a name="Question_{n}"></a><table><tr><td><span><div>{title} <i>&nbsp;(Question&nbsp;{n}&nbsp;of&nbsp;4 ) </i></div></span></td></tr></table>'
VIEW = ('<table class="noprint"></table><TD><B>Evaluator:</B></TD><TD>Dr. A - Attending</TD>'
        '<input type="hidden" name="eimnum" value="123"><FORM NAME="answerform">'
        + Q.format(n=0, title='<B>Patient Care</B>')
        + '<table><tr><td> 0 </font></td><td>1</td><td bgcolor="pink"> >> 7 <<</td><td>9</td></tr></table>'
        + Q.format(n=1, title='Medical Knowledge 1: Breadth')  # milestone titles aren't bold
        + '<table><tr><td>0</td><td>1</td><td bgcolor="pink"> >> 3.5 <<</td><td>5</td></tr></table>'
        + Q.format(n=2, title='<strong>% of time</strong>')
        + '<table><tr><td><strong>Selection</strong></td><td><strong>Option</strong></td></tr>'
        + '<tr><td>&nbsp;</td><td>50%</td></tr><tr><td><b>X</b></td><td>100%</td></tr></table>'
        + Q.format(n=3, title='<B>Comments</B>')
        + '<table><tr><td style="padding:10px;border:0">Great month. <BR></td></tr></table>')

v = app.parse_view(VIEW)
assert v['id'] == '123' and v['info']['Evaluator'] == 'Dr. A - Attending', v
kinds = [(it['title'], it['kind'], it['value'], it.get('max')) for it in v['items']]
assert kinds == [('Patient Care', 'rating', 7.0, 9.0), ('Medical Knowledge 1: Breadth', 'rating', 3.5, 5.0),
                 ('% of time', 'choice', '100%', None), ('Comments', 'text', 'Great month.', None)], kinds
assert len(app.split_views(VIEW * 3)) == 3

ROW = ('<TR class="hover"><td><input type="Checkbox" name="cb_1_555" value="tok"></td><td>'
       '<a href=\'javascript:cfViewEval("/index.cfm?eimnum=AbC%2B1%3D%3D&wtDate=0");\'>View</a></td>'
       '<td>Me</td><td>Attending of Resident</td><td>Dr. B - Community Physician</td><td>GAP</td><td>Site</td>'
       '<td>August 2026</td><td>08/01/2026 - 08/31/2026</td><td>09/01/2026</td><td>09/03/2026</td><td></td>'
       '<td>&nbsp;</td><td>Dr. B</td></TR>')
a = app.parse_about(ROW)[0]
assert (a['id'], a['tok'], a['evaluator'], a['role'], a['completed'], a['viewed']) == \
    ('555', 'AbC+1==', 'Dr. B', 'Community Physician', '09/03/2026', ''), a

DONE = ('<Table bgcolor="EEEEEE"><TR><TD><B>Activity:</B> </TD><TD> GAP </TD></TR></Table>'
        '<TABLE><TR class="hover"><TD><a onclick="openeval(\'Xy+z1AbCdEf==\',\'Educator_Eval\');">Clinical Educator</a></TD>'
        '<TD>Dr. C</TD><td>Not available</TD><TD>09/01/2026</TD><td>Completed<br>09/10/2026</td><td>Me</td></TR></TABLE>')
d = app.parse_done(DONE)[0]
assert (d['tok'], d['section'], d['subject'], d['completed'], d['activity']) == \
    ('Xy+z1AbCdEf==', 'Educator_Eval', 'Dr. C', '09/10/2026', 'GAP'), d
print('ok')
