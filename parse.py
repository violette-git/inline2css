from urllib.request import urlopen
from bs4 import BeautifulSoup
import re

# Fetch the html file
# response = urlopen('https://witness2.tech')
response = urlopen('file:///C:/Users/grant/Documents/GitHub/inline2css/test.html')

parsed_html = response.read()
# print(parsed_html)


soup = BeautifulSoup(parsed_html, 'html.parser')
# pretty_soup = soup.prettify()
# print(pretty_soup[:225])
print(soup.find_all(style=re.compile('background-color')))

id = 0
sections = []
sections.append(soup.find_all('section'))
# print(sections)
# for section in sections:
#     if True in style:
#         id = id + 1
#     print(id, section, len(section))
# params = {'name': 'section', 'attrs': {'class': 'container'}}
    
# print( soup.find(**params).text )

# if param in soup.find_all('section'):
#     print(soup.find_all('section'))